import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getBotById, getBotBySlug, listBotsForRoster, type BotRow } from '../db/repos/bots.js'
import {
  findOrCreatePeerConversation,
  getConversationForUser,
  type ConversationRow,
} from '../db/repos/conversations.js'
import { getMessage, getMessageById, insertMessage } from '../db/repos/messages.js'
import { getLatestRunningRunForUser } from '../db/repos/runs.js'
import { findUserByUsername, type UserRow } from '../db/repos/users.js'
import { enrichMessageWithAttachments } from '../lib/attachment-serializer.js'
import { DEFAULT_COMPANION_MODELS, type CuratedModelEntry } from '../lib/companion-models.js'
import type { GrokGatewayClient } from './grok-gateway-client.js'
import type { HermesClient } from './hermes-client.js'
import { emitConversationMessageUpsert } from './chat-sync-emitter.js'
import { executeAssistantRun } from './run-executor.js'
import { buildActivityLine } from './tooling-line.js'
import {
  publishAccountConversationUpsert,
  publishMessageUpsert,
} from '../streams/sse-mutation-publisher.js'
import { publishToolingLine } from '../streams/run-event-publisher.js'
import type { StreamHub } from '../streams/hub.js'

export interface MessageTeammateInput {
  db: Database.Database
  hermesClient: HermesClient
  grokGatewayClient?: GrokGatewayClient
  hermesHome?: string
  hub: StreamHub
  username: string
  name: string
  text: string
  companionModels?: CuratedModelEntry[]
  attachmentsDir?: string
  visionHistoryMaxBytes?: number
}

export interface MessageTeammateResult {
  ok: true
  from: string
  to: string
  reply: string
}

export const MESSAGE_TEAMMATE_MAX_DEPTH = 3
export const messageTeammateDepth = new AsyncLocalStorage<number>()

export async function messageTeammate(
  input: MessageTeammateInput,
): Promise<MessageTeammateResult> {
  const name = input.name.trim()
  const text = input.text.trim()
  if (!name || !text) {
    throw new Error('invalid_request')
  }

  const user = resolveUser(input.db, input.username)
  const targetBot = resolveTeammate(input.db, name)
  const callerRun = getLatestRunningRunForUser(input.db, user.id)
  if (!callerRun) {
    throw new Error('No running turn to delegate from')
  }

  const callerConversation = getConversationForUser(input.db, user.id, callerRun.conversation_id)
  if (!callerConversation) {
    throw new Error('No running turn to delegate from')
  }
  if (callerConversation.kind === 'job') {
    throw new Error('Job conversations cannot message teammates')
  }

  const callerBot = callerConversation.bot_id
    ? getBotById(input.db, callerConversation.bot_id)
    : undefined
  if (!callerBot) {
    throw new Error('Cannot message teammates without a caller bot')
  }
  if (targetBot.id === callerBot.id) {
    throw new Error('Cannot message yourself')
  }

  const depth = messageTeammateDepth.getStore() ?? 0
  if (depth >= MESSAGE_TEAMMATE_MAX_DEPTH) {
    throw new Error('message_teammate nested too deep')
  }

  const catalog = input.companionModels ?? DEFAULT_COMPANION_MODELS
  const delegationId = randomUUID()

  publishToolingLine(
    {
      hub: input.hub,
      userId: user.id,
      conversationId: callerConversation.id,
      runId: callerRun.id,
      originSessionId: callerRun.origin_session_id,
    },
    buildActivityLine({
      tool: 'message_teammate',
      argumentsJson: JSON.stringify({ name: targetBot.name }),
    }),
  )

  insertDelegatedMessage(input.db, input.hub, user.id, callerConversation, {
    content: text,
    kind: 'bot_sent',
    fromBotId: callerBot.id,
    toBotId: targetBot.id,
    delegationId,
    catalog,
  })

  const targetConversation = findOrCreatePeerConversation(input.db, {
    userId: user.id,
    targetBotId: targetBot.id,
    senderBotId: callerBot.id,
    senderName: callerBot.name,
  })
  publishAccountConversationUpsert(input.hub, input.db, user.id, targetConversation.id, catalog)

  const targetTriggerId = insertDelegatedMessage(input.db, input.hub, user.id, targetConversation, {
    content: text,
    kind: 'bot_sent',
    fromBotId: callerBot.id,
    toBotId: targetBot.id,
    delegationId,
    catalog,
  })

  const assistantMessageId = await messageTeammateDepth.run(depth + 1, () =>
    executeAssistantRun({
      db: input.db,
      hermesClient: input.hermesClient,
      grokGatewayClient: input.grokGatewayClient,
      hermesHome: input.hermesHome,
      hub: input.hub,
      conversationId: targetConversation.id,
      hermesSessionId: targetConversation.hermes_session_id,
      userMessageId: targetTriggerId,
      companionUsername: user.username,
      bootstrapPrompt: targetConversation.bootstrap_prompt,
      userId: user.id,
      originSessionId: callerRun.origin_session_id,
      attachmentsDir: input.attachmentsDir,
      visionHistoryMaxBytes: input.visionHistoryMaxBytes,
      companionModels: catalog,
    }),
  )

  const assistant = getMessage(input.db, targetConversation.id, assistantMessageId)
  if (!assistant?.content.trim()) {
    throw new Error('Teammate returned an empty reply')
  }

  insertDelegatedMessage(input.db, input.hub, user.id, callerConversation, {
    content: assistant.content,
    kind: 'bot_reply',
    fromBotId: targetBot.id,
    toBotId: callerBot.id,
    delegationId,
    catalog,
  })

  return {
    ok: true,
    from: callerBot.name,
    to: targetBot.name,
    reply: assistant.content,
  }
}

function resolveUser(db: Database.Database, username: string): UserRow {
  const user = findUserByUsername(db, username.trim())
  if (!user) {
    throw new Error(`User "${username.trim()}" not found`)
  }
  return user
}

function resolveTeammate(db: Database.Database, name: string): BotRow {
  const slug = name.toLowerCase()
  const bySlug = getBotBySlug(db, slug)
  if (bySlug) {
    return bySlug
  }

  const match = listBotsForRoster(db).find((bot) => bot.name.toLowerCase() === slug)
  if (!match) {
    throw new Error(`Unknown teammate "${name}"`)
  }
  return match
}

function insertDelegatedMessage(
  db: Database.Database,
  hub: StreamHub,
  userId: string,
  conversation: ConversationRow,
  input: {
    content: string
    kind: 'bot_sent' | 'bot_reply'
    fromBotId: string
    toBotId: string
    delegationId: string
    catalog: CuratedModelEntry[]
  },
): string {
  const messageId = insertMessage(db, {
    conversationId: conversation.id,
    role: 'assistant',
    content: input.content,
    kind: input.kind,
    fromBotId: input.fromBotId,
    toBotId: input.toBotId,
    delegationId: input.delegationId,
  })
  const message = getMessageById(db, messageId)
  if (!message) {
    throw new Error('message_not_found')
  }

  const enriched = enrichMessageWithAttachments(db, message)
  emitConversationMessageUpsert(db, userId, conversation.id, enriched)
  publishMessageUpsert(hub, userId, conversation.id, enriched, conversation.hermes_session_id)
  publishAccountConversationUpsert(hub, db, userId, conversation.id, input.catalog)
  return messageId
}
