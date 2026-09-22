import type Database from 'better-sqlite3'
import { getBotById } from '../db/repos/bots.js'
import {
  getConversationById,
  listGrokRuntimeConversations,
} from '../db/repos/conversations.js'
import {
  getMessage,
  insertMessage,
  listMessages,
  listMessagesByInputId,
  type MessageInput,
  type MessageRow,
} from '../db/repos/messages.js'
import { insertMessageProcess, type ToolingLine } from '../db/repos/process.js'
import {
  getLatestRunForConversation,
  getRunById,
  markRunCompleted,
  markRunRecovered,
  type RunRow,
} from '../db/repos/runs.js'
import { enrichMessageWithAttachments } from '../lib/attachment-serializer.js'
import { DEFAULT_COMPANION_MODELS, type CuratedModelEntry } from '../lib/companion-models.js'
import { createReplyAssembler } from '../lib/reply-assembler.js'
import type { StreamHub } from '../streams/hub.js'
import {
  publishReplyDone,
  type RunEventContext,
} from '../streams/run-event-publisher.js'
import {
  publishAccountConversationUpsert,
  publishMessageUpsert,
} from '../streams/sse-mutation-publisher.js'
import { emitConversationMessageUpsert } from './chat-sync-emitter.js'
import {
  GROK_PROMPT_TIMEOUT_MS,
  type GrokGatewayClient,
  type GrokOutboxItem,
} from './grok-gateway-client.js'
import { insertPendingInputCards } from './grok-input.js'
import { buildReasoningLine } from './tooling-line.js'

export const GROK_OUTBOX_POLL_MS = 200

export interface AppliedOutboxTurn {
  assistantText: string
  processLines: ToolingLine[]
  pendingInputs: Array<{ content: string; input: MessageInput }>
  doneSeq: number | null
  error: { error: string; code?: string; seq: number } | null
  lastSeq: number | null
}

export function applyOutboxEvents(items: GrokOutboxItem[]): AppliedOutboxTurn {
  const reply = createReplyAssembler()
  let processLines: ToolingLine[] = []
  let reasoningBuffer = ''
  let pendingInputs: Array<{ content: string; input: MessageInput }> = []
  let doneSeq: number | null = null
  let error: AppliedOutboxTurn['error'] = null
  let lastSeq: number | null = null

  const flushReasoningBuffer = () => {
    const text = reasoningBuffer.trim()
    reasoningBuffer = ''
    if (!text) {
      return
    }
    processLines.push(buildReasoningLine(text))
  }

  const resetTurn = () => {
    reply.reset()
    processLines = []
    reasoningBuffer = ''
    pendingInputs = []
    doneSeq = null
    error = null
  }

  for (const item of items) {
    lastSeq = item.seq
    const event = item.event

    if (event.type === 'turn_start') {
      resetTurn()
      continue
    }

    if (event.type === 'tooling') {
      if (event.phase === 'reasoning') {
        if (event.text) {
          reasoningBuffer += event.text
        }
        continue
      }

      flushReasoningBuffer()
      reply.onToolActivity()
      processLines.push({
        phase: event.phase,
        text: event.text,
        tool: event.tool,
        args: event.args,
      })
      continue
    }

    if (event.type === 'token') {
      flushReasoningBuffer()
      if (event.text) {
        reply.pushToken(event.text)
      }
      continue
    }

    if (event.type === 'pending_input') {
      flushReasoningBuffer()
      reply.onToolActivity()
      pendingInputs.push({ content: event.content, input: event.input })
      continue
    }

    if (event.type === 'done') {
      flushReasoningBuffer()
      doneSeq = item.seq
      break
    }

    if (event.type === 'error') {
      flushReasoningBuffer()
      error = { error: event.error, code: event.code, seq: item.seq }
      break
    }
  }

  return { assistantText: reply.text(), processLines, pendingInputs, doneSeq, error, lastSeq }
}

export function persistAssistantRun(
  db: Database.Database,
  hub: StreamHub,
  userId: string,
  runId: string | null,
  conversationId: string,
  hermesSessionId: string,
  assistantText: string,
  processLines: ToolingLine[],
  companionModels: CuratedModelEntry[],
): string {
  return db.transaction(() => {
    const assistantMessageId = insertMessage(db, {
      conversationId,
      role: 'assistant',
      content: assistantText,
    })

    let process: { lines: ToolingLine[] } | undefined
    if (processLines.length > 0) {
      insertMessageProcess(db, {
        assistantMessageId,
        conversationId,
        lines: processLines,
      })
      process = { lines: processLines }
    }

    if (runId) {
      if (
        !markRunCompleted(db, runId, assistantMessageId) &&
        !markRunRecovered(db, runId, assistantMessageId)
      ) {
        throw new Error('run_not_running')
      }
    }

    const message = getMessage(db, conversationId, assistantMessageId)
    if (!message) {
      throw new Error('message_not_found')
    }

    const enrichedMessage = {
      ...enrichMessageWithAttachments(db, message),
      ...(process ? { process } : {}),
    }

    emitConversationMessageUpsert(db, userId, conversationId, enrichedMessage, process)
    publishMessageUpsert(hub, userId, conversationId, enrichedMessage, hermesSessionId)
    publishAccountConversationUpsert(hub, db, userId, conversationId, companionModels)

    return assistantMessageId
  })()
}

export type DrainGrokOutboxResult =
  | { status: 'persisted'; messageId: string; lastSeq: number }
  | { status: 'empty' }
  | { status: 'interrupted' }
  | { status: 'error'; error: string; code?: string }
  | { status: 'timeout' }

export interface DrainGrokOutboxInput {
  db: Database.Database
  client: GrokGatewayClient
  hub: StreamHub
  conversationId: string
  userId: string
  hermesSessionId: string
  companionModels?: CuratedModelEntry[]
  runId?: string | null
  originSessionId?: string | null
  afterSeq?: number
  timeoutMs?: number
  pollMs?: number
  abortSignal?: AbortSignal
  isInterrupt?: () => boolean
  onAssistantMessageCommitted?: (ctx: {
    messageId: string
    content: string
  }) => void | Promise<void>
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export async function drainGrokOutbox(input: DrainGrokOutboxInput): Promise<DrainGrokOutboxResult> {
  const catalog = input.companionModels ?? DEFAULT_COMPANION_MODELS
  const timeoutMs = input.timeoutMs ?? GROK_PROMPT_TIMEOUT_MS
  const pollMs = input.pollMs ?? GROK_OUTBOX_POLL_MS
  const deadline = Date.now() + timeoutMs
  let afterSeq = input.afterSeq ?? 0
  const collected: GrokOutboxItem[] = []
  let watchSignal = input.abortSignal
  let sawPromptInFlight = false

  while (Date.now() < deadline) {
    if (input.isInterrupt?.()) {
      return { status: 'interrupted' }
    }

    let snapshot
    try {
      snapshot = await input.client.fetchOutbox(input.conversationId, afterSeq)
    } catch (error) {
      if (input.isInterrupt?.()) {
        return { status: 'interrupted' }
      }
      const message = error instanceof Error ? error.message : 'unknown'
      if (!sawPromptInFlight && collected.length === 0) {
        return { status: 'error', error: message }
      }
      if (Date.now() + pollMs >= deadline) {
        return { status: 'error', error: message }
      }
      const interrupted = await sleepOrInterrupt(pollMs, watchSignal, input.isInterrupt)
      if (interrupted) {
        return { status: 'interrupted' }
      }
      if (watchSignal?.aborted && !input.isInterrupt?.()) {
        watchSignal = undefined
      }
      continue
    }

    if (snapshot.prompt_in_flight) {
      sawPromptInFlight = true
    }

    if (snapshot.events.length > 0) {
      collected.push(...snapshot.events)
      afterSeq = Math.max(afterSeq, snapshot.last_seq)
    }

    const applied = applyOutboxEvents(collected)
    if (applied.error) {
      try {
        await input.client.ackOutbox(input.conversationId, applied.error.seq)
      } catch {
        // Best-effort: failing the turn still matters more than ack.
      }
      return { status: 'error', error: applied.error.error, code: applied.error.code }
    }

    if (applied.doneSeq != null) {
      return persistDrainedTurn(input, catalog, applied, applied.doneSeq)
    }

    if (!snapshot.prompt_in_flight) {
      return { status: 'empty' }
    }

    const interrupted = await sleepOrInterrupt(pollMs, watchSignal, input.isInterrupt)
    if (interrupted) {
      return { status: 'interrupted' }
    }
    if (watchSignal?.aborted && !input.isInterrupt?.()) {
      watchSignal = undefined
    }
  }

  return { status: 'timeout' }
}

export async function ackGrokOutboxThroughDone(
  client: GrokGatewayClient,
  conversationId: string,
  afterSeq = 0,
): Promise<void> {
  try {
    const snapshot = await client.fetchOutbox(conversationId, afterSeq)
    const done = [...snapshot.events].reverse().find((item) => item.event.type === 'done')
    const through = done?.seq ?? snapshot.last_seq
    if (through > afterSeq) {
      await client.ackOutbox(conversationId, through)
    }
  } catch {
    // Live persist already succeeded; startup drain will ack if needed.
  }
}

export async function drainGrokOutboxesOnStartup(input: {
  db: Database.Database
  client: GrokGatewayClient
  hub: StreamHub
  companionModels?: CuratedModelEntry[]
  timeoutMs?: number
  pollMs?: number
  log?: (message: string, meta?: Record<string, unknown>) => void
}): Promise<void> {
  const catalog = input.companionModels ?? DEFAULT_COMPANION_MODELS
  for (const conversation of listGrokRuntimeConversations(input.db)) {
    if (conversation.kind === 'user_dm' || conversation.kind === 'group') {
      continue
    }
    const latest = getLatestRunForConversation(input.db, conversation.id)
    if (latest?.error_code === 'interrupted') {
      continue
    }

    try {
      const result = await drainGrokOutbox({
        db: input.db,
        client: input.client,
        hub: input.hub,
        conversationId: conversation.id,
        userId: conversation.user_id,
        hermesSessionId: conversation.hermes_session_id,
        companionModels: catalog,
        runId: latest?.id ?? null,
        originSessionId: latest?.origin_session_id ?? null,
        timeoutMs: input.timeoutMs,
        pollMs: input.pollMs,
        log: input.log,
      })
      input.log?.('grok outbox startup drain', {
        conversationId: conversation.id,
        status: result.status,
      })
    } catch (error) {
      input.log?.('grok outbox startup drain failed', {
        conversationId: conversation.id,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

async function persistDrainedTurn(
  input: DrainGrokOutboxInput,
  catalog: CuratedModelEntry[],
  applied: AppliedOutboxTurn,
  doneSeq: number,
): Promise<DrainGrokOutboxResult> {
  const run = resolveRun(input.db, input.conversationId, input.runId)
  if (run?.error_code === 'interrupted') {
    return { status: 'interrupted' }
  }

  const trigger = resolveTrigger(input.db, input.conversationId, run)
  if (
    !trigger ||
    userMessageHasChatReply(input.db, input.conversationId, trigger.id)
  ) {
    try {
      await input.client.ackOutbox(input.conversationId, doneSeq)
    } catch {
      // Already persisted; leave leftover events for a later ack.
    }
    return { status: 'empty' }
  }

  const conversation = getConversationById(input.db, input.conversationId)
  const bot = conversation?.bot_id ? getBotById(input.db, conversation.bot_id) : undefined
  if (conversation && bot && trigger) {
    for (const pending of applied.pendingInputs) {
      if (listMessagesByInputId(input.db, pending.input.id).length > 0) {
        continue
      }
      insertPendingInputCards({
        db: input.db,
        hub: input.hub,
        userId: input.userId,
        grokConversation: conversation,
        grokBot: bot,
        trigger,
        content: pending.content,
        pendingInput: pending.input,
        companionModels: catalog,
      })
    }
  }

  const runId = run?.id ?? input.runId ?? null
  const assistantMessageId = persistAssistantRun(
    input.db,
    input.hub,
    input.userId,
    runId,
    input.conversationId,
    input.hermesSessionId,
    applied.assistantText,
    applied.processLines,
    catalog,
  )

  try {
    await input.client.ackOutbox(input.conversationId, doneSeq)
  } catch {
    // Message is durable; a later drain will see the reply and ack.
  }

  await input.onAssistantMessageCommitted?.({
    messageId: assistantMessageId,
    content: applied.assistantText,
  })

  publishReplyDone(
    {
      hub: input.hub,
      userId: input.userId,
      conversationId: input.conversationId,
      runId: runId ?? input.conversationId,
      originSessionId: input.originSessionId ?? run?.origin_session_id ?? null,
    } satisfies RunEventContext,
    assistantMessageId,
  )

  return { status: 'persisted', messageId: assistantMessageId, lastSeq: doneSeq }
}

function resolveRun(
  db: Database.Database,
  conversationId: string,
  runId?: string | null,
): RunRow | undefined {
  if (runId) {
    return getRunById(db, runId)
  }
  return getLatestRunForConversation(db, conversationId)
}

function resolveTrigger(
  db: Database.Database,
  conversationId: string,
  run: RunRow | undefined,
): MessageRow | undefined {
  if (run) {
    return getMessage(db, conversationId, run.user_message_id) ?? findLatestUnrepliedUserMessage(db, conversationId)
  }
  return findLatestUnrepliedUserMessage(db, conversationId)
}

export function findLatestUnrepliedUserMessage(
  db: Database.Database,
  conversationId: string,
): MessageRow | undefined {
  const messages = listMessages(db, conversationId)
  let latestUser: MessageRow | undefined
  for (const message of messages) {
    if (message.role === 'user') {
      latestUser = message
      continue
    }
    if (message.role === 'assistant' && message.kind !== 'pending_input') {
      latestUser = undefined
    }
  }
  return latestUser
}

function userMessageHasChatReply(
  db: Database.Database,
  conversationId: string,
  userMessageId: string,
): boolean {
  const messages = listMessages(db, conversationId)
  const index = messages.findIndex((message) => message.id === userMessageId)
  if (index < 0) {
    return false
  }
  return messages
    .slice(index + 1)
    .some((message) => message.role === 'assistant' && message.kind !== 'pending_input')
}

async function sleepOrInterrupt(
  ms: number,
  signal: AbortSignal | undefined,
  isInterrupt?: () => boolean,
): Promise<boolean> {
  if (isInterrupt?.()) {
    return true
  }

  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
        return
      }

      const timer = setTimeout(resolve, ms)
      const onAbort = () => {
        clearTimeout(timer)
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  } catch {
    return Boolean(isInterrupt?.())
  }

  return Boolean(isInterrupt?.())
}
