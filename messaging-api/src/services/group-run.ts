import type Database from 'better-sqlite3'
import type { CuratedModelEntry } from '../lib/companion-models.js'
import {
  enrichMessageWithAttachments,
  type MessageWithAttachments,
} from '../lib/attachment-serializer.js'
import { buildConversationSyncEntry } from '../lib/conversation-sync-entry.js'
import { buildGroupPrompt } from '../lib/group-prompt.js'
import {
  appendAccountMessageUpsert,
  appendConversationMessageUpsert,
} from '../db/repos/chat-sync-events.js'
import { getConversationById } from '../db/repos/conversations.js'
import {
  claimNextGroupRun,
  finishGroupRun,
  sweepStuckGroupRuns,
  type GroupRunClaim,
} from '../db/repos/group-bot-runs.js'
import { getMessage, insertMessage, listMessages, type MessageRow } from '../db/repos/messages.js'
import { publishToConversationMembers } from '../streams/sse-mutation-publisher.js'
import type { StreamHub } from '../streams/hub.js'
import { emitAccountConversationUpsert, emitToConversationMembers } from './chat-sync-emitter.js'
import * as hermesAuxiliaryClient from './hermes-auxiliary-client.js'

const GROUP_MAX_TOKENS = 2048

export interface GroupRunDeps {
  db: Database.Database
  hub: StreamHub
  bridgeUrl: string
  bridgeApiKey: string
  timeoutMs: number
  catalog: CuratedModelEntry[]
  log?: (message: string, meta?: Record<string, unknown>) => void
}

// ponytail: one drain chain per process. Split by conversation if one run blocks the timer.
let drainChain: Promise<void> = Promise.resolve()

export function drainGroupRuns(deps: GroupRunDeps): Promise<void> {
  const job = drainChain.then(() => runGroupQueue(deps))
  drainChain = job.then(
    () => undefined,
    () => undefined,
  )
  return job
}

export function groupPromptForMention(
  db: Database.Database,
  input: { conversationId: string; botId: string; username: string; text: string },
): { text: string; fits: boolean } {
  const botName = botNameById(db, input.botId)
  return buildGroupPrompt({
    botName,
    context: groupContextLines(db, input.conversationId, botName, Number.MAX_SAFE_INTEGER),
    primary: { username: input.username, text: input.text },
  })
}

export function appendGroupAssistantMessage(
  db: Database.Database,
  conversation: { id: string; user_id: string },
  content: string,
  catalog: CuratedModelEntry[],
): MessageWithAttachments {
  const messageId = insertMessage(db, {
    conversationId: conversation.id,
    role: 'assistant',
    content,
  })
  const stored = getMessage(db, conversation.id, messageId)
  if (!stored) {
    throw new Error('message_not_found')
  }
  const enriched = enrichMessageWithAttachments(db, stored)
  emitToConversationMembers(db, conversation.id, (userId) => {
    appendAccountMessageUpsert(db, userId, conversation.id, enriched)
    emitAccountConversationUpsert(db, userId, conversation.id, catalog)
  })
  appendConversationMessageUpsert(db, conversation.user_id, conversation.id, enriched)
  return enriched
}

async function runGroupQueue(deps: GroupRunDeps): Promise<void> {
  for (const messageId of sweepStuckGroupRuns(deps.db)) {
    const row = deps.db
      .prepare(`SELECT conversation_id, run_id FROM group_bot_runs WHERE message_id = ?`)
      .get(messageId) as { conversation_id: string; run_id: string } | undefined
    if (!row) {
      continue
    }
    const conversation = getConversationById(deps.db, row.conversation_id)
    if (!conversation) {
      continue
    }
    const message = appendGroupAssistantMessage(deps.db, conversation, 'run_unconfirmed', deps.catalog)
    publishGroupTerminal(deps, conversation, row.run_id, message)
  }

  for (;;) {
    const claim = claimNextGroupRun(deps.db)
    if (!claim) {
      return
    }
    try {
      await executeClaimedGroupRun(deps, claim)
    } catch (error) {
      deps.log?.('group run failed', {
        err: error instanceof Error ? error.message : String(error),
        conversationId: claim.conversationId,
      })
      commitGroupOutput(deps, claim, 'failed', 'run_failed', 'run_failed')
    }
  }
}

async function executeClaimedGroupRun(deps: GroupRunDeps, claim: GroupRunClaim): Promise<void> {
  const conversation = getConversationById(deps.db, claim.conversationId)
  const trigger = getMessage(deps.db, claim.conversationId, claim.messageId)
  if (!conversation || !trigger) {
    commitGroupOutput(deps, claim, 'failed', 'run_failed', 'run_failed')
    return
  }

  const botName = botNameById(deps.db, conversation.bot_id)
  const prompt = buildGroupPrompt({
    botName,
    context: groupContextLines(deps.db, claim.conversationId, botName, trigger.sequence ?? 0),
    primary: {
      username: trigger.sender_user?.username ?? 'user',
      text: trigger.content,
    },
  })
  if (!prompt.fits) {
    commitGroupOutput(deps, claim, 'failed', 'context_too_large', 'context_too_large')
    return
  }

  publishToConversationMembers(deps.hub, deps.db, claim.conversationId, {
    event: 'reply',
    data: { conversationId: claim.conversationId, runId: claim.runId, phase: 'typing' },
  })

  try {
    const text = await hermesAuxiliaryClient.completeHermesAuxiliary(
      deps.bridgeUrl,
      deps.bridgeApiKey,
      {
        provider: conversation.provider,
        model: conversation.model,
        messages: [{ role: 'user', content: prompt.text }],
        timeoutMs: deps.timeoutMs,
        maxTokens: GROUP_MAX_TOKENS,
      },
    )
    commitGroupOutput(deps, claim, 'done', text)
  } catch (error) {
    const code = groupRunFailureCode(error)
    commitGroupOutput(deps, claim, 'failed', code, code)
  }
}

function commitGroupOutput(
  deps: GroupRunDeps,
  claim: GroupRunClaim,
  to: 'done' | 'failed',
  content: string,
  errorCode?: string,
): void {
  const conversation = getConversationById(deps.db, claim.conversationId)
  if (!conversation) {
    finishGroupRun(deps.db, claim.messageId, 'running', to, errorCode)
    return
  }
  const message = deps.db.transaction(() => {
    if (!finishGroupRun(deps.db, claim.messageId, 'running', to, errorCode)) {
      return null
    }
    return appendGroupAssistantMessage(deps.db, conversation, content, deps.catalog)
  })()
  if (!message) {
    return
  }
  publishGroupTerminal(deps, conversation, claim.runId, message)
}

function publishGroupTerminal(
  deps: GroupRunDeps,
  conversation: NonNullable<ReturnType<typeof getConversationById>>,
  runId: string,
  message: MessageWithAttachments,
): void {
  publishToConversationMembers(deps.hub, deps.db, conversation.id, {
    event: 'reply',
    data: {
      conversationId: conversation.id,
      runId,
      phase: 'done',
      messageId: message.id,
    },
  })
  publishToConversationMembers(deps.hub, deps.db, conversation.id, {
    event: 'message_upsert',
    data: { conversationId: conversation.id, message },
  })
  const fresh = getConversationById(deps.db, conversation.id) ?? conversation
  publishToConversationMembers(deps.hub, deps.db, conversation.id, {
    event: 'conversation_upsert',
    data: { conversation: buildConversationSyncEntry(deps.db, fresh, deps.catalog) },
  })
}

function groupRunFailureCode(error: unknown): 'runtime_unavailable' | 'run_failed' {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /\bprovider\b/i.test(message) &&
    /unsupported|unknown|invalid|unrecognized|not supported|rejected/i.test(message)
  ) {
    return 'runtime_unavailable'
  }
  return 'run_failed'
}

function groupContextLines(
  db: Database.Database,
  conversationId: string,
  botName: string,
  beforeSequence: number,
): Array<{ author: string; text: string }> {
  const visible = listMessages(db, conversationId)
    .filter(
      (message) =>
        message.sequence != null && message.sequence < beforeSequence && isGroupVisible(message),
    )
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  let boundary = -1
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    if (visible[index]?.role === 'assistant') {
      boundary = index
      break
    }
  }
  const window = boundary < 0 ? visible : visible.slice(boundary)
  return window.map((message) => ({
    author: message.role === 'assistant' ? botName : (message.sender_user?.username ?? 'user'),
    text: message.content,
  }))
}

function isGroupVisible(message: MessageRow): boolean {
  if (message.role === 'user') {
    return true
  }
  return message.kind === 'chat' && !message.delegation_id && !message.input
}

function botNameById(db: Database.Database, botId: string | null): string {
  if (!botId) {
    return 'bot'
  }
  const row = db.prepare(`SELECT name FROM bots WHERE id = ?`).get(botId) as { name: string } | undefined
  return row?.name ?? 'bot'
}

