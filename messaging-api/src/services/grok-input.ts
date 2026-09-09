import type Database from 'better-sqlite3'
import {
  getBotById,
  normalizeBotRuntime,
  type BotRow,
} from '../db/repos/bots.js'
import {
  getConversationById,
  type ConversationRow,
} from '../db/repos/conversations.js'
import {
  getMessage,
  insertMessage,
  listMessagesByInputId,
  updateMessageInput,
  type MessageInput,
  type MessageInputStatus,
  type MessageRow,
} from '../db/repos/messages.js'
import { getActiveRun } from '../db/repos/runs.js'
import { enrichMessageWithAttachments } from '../lib/attachment-serializer.js'
import { DEFAULT_COMPANION_MODELS, type CuratedModelEntry } from '../lib/companion-models.js'
import { emitConversationMessageUpsert } from './chat-sync-emitter.js'
import {
  GrokGatewayError,
  type GrokGatewayClient,
  type GrokInputAction,
} from './grok-gateway-client.js'
import {
  publishAccountConversationUpsert,
  publishMessageUpsert,
} from '../streams/sse-mutation-publisher.js'
import type { StreamHub } from '../streams/hub.js'

export type GrokInputErrorCode =
  | 'not_found'
  | 'not_pending'
  | 'run_not_running'
  | 'invalid_action'
  | 'invalid_request'
  | 'grok_unavailable'

export class GrokInputError extends Error {
  constructor(readonly code: GrokInputErrorCode) {
    super(code)
    this.name = 'GrokInputError'
  }
}

export function insertPendingInputCards(input: {
  db: Database.Database
  hub: StreamHub
  userId: string
  grokConversation: ConversationRow
  grokBot: BotRow
  trigger: MessageRow
  content: string
  pendingInput: MessageInput
  companionModels?: CuratedModelEntry[]
}): void {
  const catalog = input.companionModels ?? DEFAULT_COMPANION_MODELS
  const pending: MessageInput = { ...input.pendingInput, status: 'pending' }

  insertAndPublish(input.db, input.hub, input.userId, input.grokConversation, catalog, {
    content: input.content,
    input: pending,
    kind: 'pending_input',
    fromBotId: input.trigger.from_bot_id,
    toBotId: input.trigger.to_bot_id,
    delegationId: input.trigger.delegation_id,
  })

  const callerConversationId = findCallerConversationId(
    input.db,
    input.grokConversation.id,
    input.trigger.delegation_id,
  )
  if (!callerConversationId) {
    return
  }

  const callerConversation = getConversationById(input.db, callerConversationId)
  if (!callerConversation) {
    return
  }

  insertAndPublish(input.db, input.hub, input.userId, callerConversation, catalog, {
    content: input.content,
    input: pending,
    kind: 'pending_input',
    fromBotId: input.grokBot.id,
    toBotId: input.trigger.from_bot_id,
    delegationId: input.trigger.delegation_id,
  })
}

export async function resolveGrokInput(input: {
  db: Database.Database
  hub: StreamHub
  grokGatewayClient: GrokGatewayClient
  userId: string
  conversationId: string
  messageId: string
  action: string
  text?: string
  companionModels?: CuratedModelEntry[]
}): Promise<void> {
  const conversation = getConversationById(input.db, input.conversationId)
  if (!conversation || conversation.user_id !== input.userId) {
    throw new GrokInputError('not_found')
  }

  const message = getMessage(input.db, input.conversationId, input.messageId)
  if (!message) {
    throw new GrokInputError('not_found')
  }
  if (message.kind !== 'pending_input' || message.input?.status !== 'pending') {
    throw new GrokInputError('not_pending')
  }

  const action = parseAction(input.action)
  if (!action) {
    throw new GrokInputError('invalid_request')
  }
  if (!actionMatchesType(action, message.input.type)) {
    throw new GrokInputError('invalid_action')
  }
  if (action === 'reply' && !input.text?.trim()) {
    throw new GrokInputError('invalid_request')
  }

  const copies = listMessagesByInputId(input.db, message.input.id)
  const grokConversation = findGrokConversation(input.db, copies) ?? conversation
  if (!getActiveRun(input.db, grokConversation.id)) {
    throw new GrokInputError('run_not_running')
  }

  try {
    await input.grokGatewayClient.resolveInput(grokConversation.id, {
      input_id: message.input.id,
      action,
      ...(action === 'reply' ? { text: input.text!.trim() } : {}),
    })
  } catch (error) {
    if (error instanceof GrokGatewayError) {
      if (error.code === 'not_pending' || error.code === 'invalid_action') {
        throw new GrokInputError(error.code)
      }
      throw new GrokInputError('grok_unavailable')
    }
    throw new GrokInputError('grok_unavailable')
  }

  const nextStatus = statusForAction(action)
  const catalog = input.companionModels ?? DEFAULT_COMPANION_MODELS
  for (const copy of copies.length > 0 ? copies : [message]) {
    if (!copy.input) {
      continue
    }
    const updated = updateMessageInput(input.db, copy.id, { ...copy.input, status: nextStatus })
    if (!updated) {
      continue
    }
    publishInputMessage(input.db, input.hub, input.userId, updated, catalog)
  }
}

export function cancelPendingInputsForConversation(input: {
  db: Database.Database
  hub: StreamHub
  userId: string
  conversationId: string
  companionModels?: CuratedModelEntry[]
}): void {
  const catalog = input.companionModels ?? DEFAULT_COMPANION_MODELS
  const seen = new Set<string>()
  const rows = input.db
    .prepare(
      `
        SELECT id FROM messages
        WHERE conversation_id = ?
          AND kind = 'pending_input'
          AND json_extract(input_json, '$.status') = 'pending'
      `,
    )
    .all(input.conversationId) as Array<{ id: string }>

  for (const row of rows) {
    const message = getMessage(input.db, input.conversationId, row.id)
    const inputId = message?.input?.id
    if (!inputId || seen.has(inputId)) {
      continue
    }
    seen.add(inputId)
    for (const copy of listMessagesByInputId(input.db, inputId)) {
      if (copy.input?.status !== 'pending') {
        continue
      }
      const updated = updateMessageInput(input.db, copy.id, { ...copy.input, status: 'cancelled' })
      if (updated) {
        publishInputMessage(input.db, input.hub, input.userId, updated, catalog)
      }
    }
  }
}

function parseAction(value: string): GrokInputAction | null {
  if (value === 'allow' || value === 'deny' || value === 'reply') {
    return value
  }
  return null
}

function actionMatchesType(action: GrokInputAction, type: MessageInput['type']): boolean {
  if (type === 'permission') {
    return action === 'allow' || action === 'deny'
  }
  return action === 'reply'
}

function statusForAction(action: GrokInputAction): MessageInputStatus {
  if (action === 'allow') {
    return 'allowed'
  }
  if (action === 'deny') {
    return 'denied'
  }
  return 'answered'
}

function findCallerConversationId(
  db: Database.Database,
  grokConversationId: string,
  delegationId: string | null,
): string | undefined {
  if (!delegationId) {
    return undefined
  }
  const row = db
    .prepare(
      `
        SELECT conversation_id
        FROM messages
        WHERE delegation_id = ?
          AND conversation_id != ?
        LIMIT 1
      `,
    )
    .get(delegationId, grokConversationId) as { conversation_id: string } | undefined
  return row?.conversation_id
}

function findGrokConversation(
  db: Database.Database,
  copies: MessageRow[],
): ConversationRow | undefined {
  for (const copy of copies) {
    const conversation = getConversationById(db, copy.conversation_id)
    if (!conversation?.bot_id) {
      continue
    }
    const bot = getBotById(db, conversation.bot_id)
    if (bot && normalizeBotRuntime(bot.runtime) === 'grok') {
      return conversation
    }
  }
  return undefined
}

function insertAndPublish(
  db: Database.Database,
  hub: StreamHub,
  userId: string,
  conversation: ConversationRow,
  catalog: CuratedModelEntry[],
  input: {
    content: string
    input: MessageInput
    kind: 'pending_input'
    fromBotId?: string | null
    toBotId?: string | null
    delegationId?: string | null
  },
): void {
  const messageId = insertMessage(db, {
    conversationId: conversation.id,
    role: 'assistant',
    content: input.content,
    kind: input.kind,
    fromBotId: input.fromBotId,
    toBotId: input.toBotId,
    delegationId: input.delegationId,
    input: input.input,
  })
  const message = getMessage(db, conversation.id, messageId)
  if (!message) {
    throw new Error('message_not_found')
  }
  publishInputMessage(db, hub, userId, message, catalog)
}

function publishInputMessage(
  db: Database.Database,
  hub: StreamHub,
  userId: string,
  message: MessageRow,
  catalog: CuratedModelEntry[],
): void {
  const conversation = getConversationById(db, message.conversation_id)
  const enriched = enrichMessageWithAttachments(db, message)
  emitConversationMessageUpsert(db, userId, message.conversation_id, enriched)
  publishMessageUpsert(
    hub,
    userId,
    message.conversation_id,
    enriched,
    conversation?.hermes_session_id,
  )
  publishAccountConversationUpsert(hub, db, userId, message.conversation_id, catalog)
}
