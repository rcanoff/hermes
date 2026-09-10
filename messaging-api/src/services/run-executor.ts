import type Database from 'better-sqlite3'
import { getMessage, listMessages, type MessageRow } from '../db/repos/messages.js'
import type { ToolingLine } from '../db/repos/process.js'
import { createRun, markRunFailed } from '../db/repos/runs.js'
import type { StreamHub } from '../streams/hub.js'
import {
  publishReplyDone,
  publishReplyToken,
  publishRewind,
  publishRunError,
  publishToolingComplete,
  publishToolingDraft,
  publishToolingLine,
  type RunEventContext,
} from '../streams/run-event-publisher.js'
import { listAttachmentsForMessages } from '../db/repos/message-attachments.js'
import { botSummariesForMessages } from '../lib/attachment-serializer.js'
import {
  getBotById,
  listBotsForRoster,
  normalizeBotRuntime,
  soulForResponse,
  type BotRow,
} from '../db/repos/bots.js'
import {
  getConversationBotSlug,
  getConversationForUser,
  type ConversationRow,
} from '../db/repos/conversations.js'
import { buildBotRosterPrompt } from '../lib/bot-roster.js'
import { DEFAULT_COMPANION_MODELS, type CuratedModelEntry } from '../lib/companion-models.js'
import { DEFAULT_BOT_SLUG } from '../lib/hermes-profile.js'
import { buildHermesMessages, mapDelegationForHermes } from './prompt-builder.js'
import type { HermesClient } from './hermes-client.js'
import {
  createGrokGatewayClient,
  GROK_PROMPT_IN_FLIGHT_RETRY_MS,
  GrokGatewayError,
  type GrokGatewayClient,
  type GrokGatewayEvent,
} from './grok-gateway-client.js'
import { cancelPendingInputsForConversation, insertPendingInputCards } from './grok-input.js'
import {
  buildActivityLine,
  buildReasoningLine,
} from './tooling-line.js'
import {
  ackGrokOutboxThroughDone,
  drainGrokOutbox,
  persistAssistantRun,
} from './grok-outbox-drain.js'
import type { AuxiliaryLlmConfig } from './auxiliary-llm-client.js'
import { listHermesJobIdsFromFile } from '../lib/hermes-cron-jobs.js'
import { autoLinkNewCompanionCronJobs } from './companion-cron-auto-link.js'
import type { RunAbortRegistry } from './run-abort-registry.js'

export interface ExecuteAssistantRunInput {
  db: Database.Database
  hermesClient: HermesClient
  grokGatewayClient?: GrokGatewayClient
  hermesHome?: string
  hub: StreamHub
  conversationId: string
  hermesSessionId: string
  userMessageId: string
  companionUsername?: string
  bootstrapPrompt?: string | null
  runId?: string
  rewindMessageIds?: string[]
  userId: string
  originSessionId: string | null
  attachmentsDir?: string
  visionHistoryMaxBytes?: number
  cronJobsPath?: string
  conversationTitle?: string | null
  cronPromptSynthesisLlm?: AuxiliaryLlmConfig | null
  companionModels?: CuratedModelEntry[]
  onAssistantMessageCommitted?: (ctx: {
    messageId: string
    content: string
  }) => void | Promise<void>
  log?: (message: string, meta?: Record<string, unknown>) => void
  abortRegistry?: RunAbortRegistry
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function executeAssistantRun(input: ExecuteAssistantRunInput): Promise<string> {
  const runId =
    input.runId ??
    createRun(input.db, input.conversationId, input.userMessageId, input.originSessionId ?? 'legacy')
  const abortSignal = input.abortRegistry?.start(input.conversationId)
  const history = listMessages(input.db, input.conversationId)
  const attachmentMap = listAttachmentsForMessages(
    input.db,
    history.map((message) => message.id),
  )
  const bots = botSummariesForMessages(input.db, history)
  const historyWithAttachments = history.map((message) => ({
    ...message,
    attachments: attachmentMap.get(message.id),
    from_bot: message.from_bot_id ? bots.get(message.from_bot_id) ?? null : null,
    to_bot: message.to_bot_id ? bots.get(message.to_bot_id) ?? null : null,
  }))

  const streamCtx: RunEventContext = {
    hub: input.hub,
    userId: input.userId,
    conversationId: input.conversationId,
    runId,
    originSessionId: input.originSessionId,
  }

  let assistantText = ''
  let sawDone = false
  const processLines: ToolingLine[] = []
  let reasoningBuffer = ''
  let inReplyPhase = false
  let sawFirstTool = false
  let outstandingTools = 0
  let sawToolingActivity = false
  let sawCronjobTool = false
  const knownJobIdsBefore = input.cronJobsPath
    ? await listHermesJobIdsFromFile(input.cronJobsPath)
    : new Set<string>()

  const publishProcessLine = (line: ToolingLine) => {
    processLines.push(line)
    sawToolingActivity = true
    publishToolingLine(streamCtx, line)
  }

  const flushReasoningBuffer = () => {
    const text = reasoningBuffer.trim()
    reasoningBuffer = ''
    if (!text) {
      return
    }

    publishProcessLine(buildReasoningLine(text))
  }

  const beginReplyPhase = () => {
    if (inReplyPhase) {
      return
    }

    flushReasoningBuffer()
    inReplyPhase = true
    if (sawToolingActivity) {
      publishToolingComplete(streamCtx)
    }
  }

  if (input.rewindMessageIds && input.rewindMessageIds.length > 0) {
    publishRewind(streamCtx, input.rewindMessageIds)
  }

  const conversation = getConversationForUser(input.db, input.userId, input.conversationId)
  const bot = conversation?.bot_id ? getBotById(input.db, conversation.bot_id) : undefined
  if (conversation && bot && normalizeBotRuntime(bot.runtime) === 'grok') {
    try {
      return await executeGrokAssistantRun({
        ...input,
        runId,
        streamCtx,
        conversation,
        bot,
        processLines,
        beginReplyPhase,
        publishProcessLine,
        abortSignal,
      })
    } finally {
      if (abortSignal) {
        input.abortRegistry?.finish(input.conversationId, abortSignal)
      }
    }
  }

  try {
    const botSlug = getConversationBotSlug(input.db, input.conversationId)
    const rosterPrompt = botSlug
      ? buildBotRosterPrompt(listBotsForRoster(input.db), botSlug)
      : undefined
    const currentBotId = getConversationForUser(
      input.db,
      input.userId,
      input.conversationId,
    )?.bot_id

    const hermesMessages = await buildHermesMessages(historyWithAttachments, {
      bootstrapPrompt: input.bootstrapPrompt,
      companionUsername: input.companionUsername,
      rosterPrompt,
      attachmentsDir: input.attachmentsDir,
      userId: input.userId,
      visionHistoryMaxBytes: input.visionHistoryMaxBytes,
      currentBotId,
    })

    const profileSlug = botSlug && botSlug !== DEFAULT_BOT_SLUG ? botSlug : undefined

    for await (const event of input.hermesClient.streamChat({
      hermesSessionId: input.hermesSessionId,
      messages: hermesMessages,
      companionUserId: input.userId,
      ...(profileSlug ? { profileSlug } : {}),
      ...(abortSignal ? { signal: abortSignal } : {}),
    })) {
      if (abortSignal?.aborted) {
        break
      }
      if (event.type === 'reasoning' && event.text) {
        reasoningBuffer += event.text
        sawToolingActivity = true
        publishToolingDraft(streamCtx, event.text)
        continue
      }

      if (event.type === 'tool' && event.name) {
        flushReasoningBuffer()
        sawFirstTool = true
        outstandingTools++
        if (event.name === 'cronjob') {
          sawCronjobTool = true
        }
        const line = buildActivityLine({
          tool: event.name,
          label: event.label,
          argumentsJson: event.arguments,
        })
        publishProcessLine(line)
        continue
      }

      if (event.type === 'tool_complete') {
        outstandingTools = Math.max(0, outstandingTools - 1)
        if (event.name === 'cronjob') {
          sawCronjobTool = true
        }
        continue
      }

      if (event.type === 'answer_token' && event.text) {
        if (inReplyPhase) {
          assistantText += event.text
          publishReplyToken(streamCtx, event.text)
          continue
        }

        if (!sawFirstTool) {
          beginReplyPhase()
          assistantText += event.text
          publishReplyToken(streamCtx, event.text)
          continue
        }

        if (outstandingTools > 0) {
          outstandingTools = 0
        }

        beginReplyPhase()
        assistantText += event.text
        publishReplyToken(streamCtx, event.text)
        continue
      }

      if (event.type === 'done') {
        sawDone = true
      }
    }

    if (abortSignal?.aborted) {
      return finalizeInterruptedRun({
        db: input.db,
        hub: input.hub,
        userId: input.userId,
        runId,
        conversationId: input.conversationId,
        hermesSessionId: input.hermesSessionId,
        assistantText,
        processLines,
        streamCtx,
        companionModels: input.companionModels ?? DEFAULT_COMPANION_MODELS,
        onAssistantMessageCommitted: input.onAssistantMessageCommitted,
      })
    }

    if (!sawDone) {
      throw new Error('Hermes stream ended without a done event')
    }

    if (!assistantText.trim()) {
      throw new Error('Hermes stream completed without assistant text')
    }

    const assistantMessageId = persistAssistantRun(
      input.db,
      input.hub,
      input.userId,
      runId,
      input.conversationId,
      input.hermesSessionId,
      assistantText,
      processLines,
      input.companionModels ?? DEFAULT_COMPANION_MODELS,
    )

    if (input.cronJobsPath && input.companionUsername) {
      try {
        await autoLinkNewCompanionCronJobs({
          db: input.db,
          userId: input.userId,
          username: input.companionUsername,
          sourceConversationId: input.conversationId,
          cronJobsPath: input.cronJobsPath,
          knownJobIdsBefore,
          sawCronjobTool,
          hermesClient: input.hermesClient,
          cronPromptSynthesisLlm: input.cronPromptSynthesisLlm,
          log: input.log,
        })
      } catch (error) {
        input.log?.('companion cron auto-link pass failed', {
          conversationId: input.conversationId,
          err: error instanceof Error ? error.message : String(error),
        })
      }
    }

    await input.onAssistantMessageCommitted?.({
      messageId: assistantMessageId,
      content: assistantText,
    })

    publishReplyDone(streamCtx, assistantMessageId)

    return assistantMessageId
  } catch (error) {
    if (abortSignal?.aborted || isAbortError(error)) {
      return finalizeInterruptedRun({
        db: input.db,
        hub: input.hub,
        userId: input.userId,
        runId,
        conversationId: input.conversationId,
        hermesSessionId: input.hermesSessionId,
        assistantText,
        processLines,
        streamCtx,
        companionModels: input.companionModels ?? DEFAULT_COMPANION_MODELS,
        onAssistantMessageCommitted: input.onAssistantMessageCommitted,
      })
    }
    const message = error instanceof Error ? error.message : 'unknown'
    markRunFailed(input.db, runId, 'hermes_stream_failed', message)
    publishRunError(streamCtx, 'hermes_stream_failed')
    throw error
  } finally {
    if (abortSignal) {
      input.abortRegistry?.finish(input.conversationId, abortSignal)
    }
  }
}

async function executeGrokAssistantRun(
  input: ExecuteAssistantRunInput & {
    runId: string
    streamCtx: RunEventContext
    conversation: ConversationRow
    bot: BotRow
    processLines: ToolingLine[]
    beginReplyPhase: () => void
    publishProcessLine: (line: ToolingLine) => void
    abortSignal?: AbortSignal
  },
): Promise<string> {
  const grokClient = input.grokGatewayClient ?? createGrokGatewayClient('', '')
  const catalog = input.companionModels ?? DEFAULT_COMPANION_MODELS
  let assistantText = ''
  let sawDone = false
  let attemptedOutboxRecover = false
  let reasoningBuffer = ''

  const flushReasoningBuffer = () => {
    const text = reasoningBuffer.trim()
    reasoningBuffer = ''
    if (!text) {
      return
    }

    input.publishProcessLine(buildReasoningLine(text))
  }

  const beginReplyPhase = () => {
    flushReasoningBuffer()
    input.beginReplyPhase()
  }

  try {
    const rosterPrompt = buildBotRosterPrompt(listBotsForRoster(input.db), input.bot.slug)
    const soul = [soulForResponse(input.bot, input.hermesHome ?? ''), rosterPrompt]
      .filter((part) => part.trim())
      .join('\n\n')
    await grokClient.putSession(input.conversationId, { soul })

    const trigger = getMessage(input.db, input.conversationId, input.userMessageId)
    if (!trigger) {
      throw new GrokGatewayError('grok_unavailable', 'trigger_missing')
    }
    const text = grokPromptText(input.db, trigger, input.conversation.bot_id)

    for await (const event of promptGrokTurn(
      grokClient,
      input.conversationId,
      {
        text,
        user_id: input.userId,
      },
      input.abortSignal,
    )) {
      if (grokRunWasInterrupted(input)) {
        break
      }
      if (event.type === 'tooling') {
        if (event.phase === 'reasoning') {
          if (event.text) {
            reasoningBuffer += event.text
            publishToolingDraft(input.streamCtx, event.text)
          }
          continue
        }

        flushReasoningBuffer()
        input.publishProcessLine({
          phase: event.phase,
          text: event.text,
          tool: event.tool,
          args: event.args,
        })
        continue
      }

      if (event.type === 'token' && event.text) {
        beginReplyPhase()
        assistantText += event.text
        publishReplyToken(input.streamCtx, event.text)
        continue
      }

      if (event.type === 'pending_input') {
        flushReasoningBuffer()
        insertPendingInputCards({
          db: input.db,
          hub: input.hub,
          userId: input.userId,
          grokConversation: input.conversation,
          grokBot: input.bot,
          trigger,
          content: event.content,
          pendingInput: event.input,
          companionModels: catalog,
        })
        continue
      }

      if (event.type === 'done') {
        flushReasoningBuffer()
        sawDone = true
        continue
      }

      if (event.type === 'error') {
        flushReasoningBuffer()
        throw new GrokGatewayError('grok_unavailable', event.error)
      }
    }

    if (grokRunWasInterrupted(input)) {
      return finalizeInterruptedRun({
        db: input.db,
        hub: input.hub,
        userId: input.userId,
        runId: input.runId,
        conversationId: input.conversationId,
        hermesSessionId: input.hermesSessionId,
        assistantText,
        processLines: input.processLines,
        streamCtx: input.streamCtx,
        companionModels: catalog,
        onAssistantMessageCommitted: input.onAssistantMessageCommitted,
      })
    }

    if (!sawDone) {
      attemptedOutboxRecover = true
      const recovered = await recoverGrokTurnFromOutbox(input, catalog)
      if (recovered === 'interrupted') {
        return finalizeInterruptedRun({
          db: input.db,
          hub: input.hub,
          userId: input.userId,
          runId: input.runId,
          conversationId: input.conversationId,
          hermesSessionId: input.hermesSessionId,
          assistantText,
          processLines: input.processLines,
          streamCtx: input.streamCtx,
          companionModels: catalog,
          onAssistantMessageCommitted: input.onAssistantMessageCommitted,
        })
      }
      if (recovered) {
        return recovered
      }
      throw new GrokGatewayError('grok_unavailable', 'stream_ended')
    }

    beginReplyPhase()
    const assistantMessageId = persistAssistantRun(
      input.db,
      input.hub,
      input.userId,
      input.runId,
      input.conversationId,
      input.hermesSessionId,
      assistantText,
      input.processLines,
      catalog,
    )

    await ackGrokOutboxThroughDone(grokClient, input.conversationId)
    await input.onAssistantMessageCommitted?.({
      messageId: assistantMessageId,
      content: assistantText,
    })
    publishReplyDone(input.streamCtx, assistantMessageId)
    return assistantMessageId
  } catch (error) {
    if (grokRunWasInterrupted(input)) {
      return finalizeInterruptedRun({
        db: input.db,
        hub: input.hub,
        userId: input.userId,
        runId: input.runId,
        conversationId: input.conversationId,
        hermesSessionId: input.hermesSessionId,
        assistantText,
        processLines: input.processLines,
        streamCtx: input.streamCtx,
        companionModels: catalog,
        onAssistantMessageCommitted: input.onAssistantMessageCommitted,
      })
    }

    if (!sawDone && !attemptedOutboxRecover) {
      attemptedOutboxRecover = true
      try {
        const recovered = await recoverGrokTurnFromOutbox(input, catalog)
        if (recovered === 'interrupted') {
          return finalizeInterruptedRun({
            db: input.db,
            hub: input.hub,
            userId: input.userId,
            runId: input.runId,
            conversationId: input.conversationId,
            hermesSessionId: input.hermesSessionId,
            assistantText,
            processLines: input.processLines,
            streamCtx: input.streamCtx,
            companionModels: catalog,
            onAssistantMessageCommitted: input.onAssistantMessageCommitted,
          })
        }
        if (recovered) {
          return recovered
        }
      } catch (drainError) {
        cancelPendingInputsForConversation({
          db: input.db,
          hub: input.hub,
          userId: input.userId,
          conversationId: input.conversationId,
          companionModels: catalog,
        })
        const drainMessage = drainError instanceof Error ? drainError.message : 'unknown'
        markRunFailed(input.db, input.runId, 'grok_unavailable', drainMessage)
        publishRunError(input.streamCtx, 'grok_unavailable')
        throw drainError
      }
    }

    if (grokRunWasInterrupted(input)) {
      return finalizeInterruptedRun({
        db: input.db,
        hub: input.hub,
        userId: input.userId,
        runId: input.runId,
        conversationId: input.conversationId,
        hermesSessionId: input.hermesSessionId,
        assistantText,
        processLines: input.processLines,
        streamCtx: input.streamCtx,
        companionModels: catalog,
        onAssistantMessageCommitted: input.onAssistantMessageCommitted,
      })
    }
    cancelPendingInputsForConversation({
      db: input.db,
      hub: input.hub,
      userId: input.userId,
      conversationId: input.conversationId,
      companionModels: catalog,
    })
    const message = error instanceof Error ? error.message : 'unknown'
    markRunFailed(input.db, input.runId, 'grok_unavailable', message)
    publishRunError(input.streamCtx, 'grok_unavailable')
    throw error
  }
}

async function finalizeInterruptedRun(input: {
  db: Database.Database
  hub: StreamHub
  userId: string
  runId: string
  conversationId: string
  hermesSessionId: string
  assistantText: string
  processLines: ToolingLine[]
  streamCtx: RunEventContext
  companionModels: CuratedModelEntry[]
  onAssistantMessageCommitted?: (ctx: { messageId: string; content: string }) => void | Promise<void>
}): Promise<string> {
  if (input.assistantText.trim()) {
    const assistantMessageId = persistAssistantRun(
      input.db,
      input.hub,
      input.userId,
      input.runId,
      input.conversationId,
      input.hermesSessionId,
      input.assistantText,
      input.processLines,
      input.companionModels,
    )
    await input.onAssistantMessageCommitted?.({
      messageId: assistantMessageId,
      content: input.assistantText,
    })
    publishReplyDone(input.streamCtx, assistantMessageId)
    return assistantMessageId
  }

  markRunFailed(input.db, input.runId, 'interrupted', 'Interrupted by user')
  publishRunError(input.streamCtx, 'interrupted')
  return ''
}

async function* promptGrokTurn(
  client: GrokGatewayClient,
  conversationId: string,
  body: { text: string; user_id: string },
  signal?: AbortSignal,
): AsyncIterable<GrokGatewayEvent> {
  try {
    yield* client.prompt(conversationId, body, signal)
    return
  } catch (error) {
    if (
      !(error instanceof GrokGatewayError) ||
      error.code !== 'prompt_in_flight' ||
      signal?.aborted
    ) {
      throw error
    }
  }

  try {
    await client.cancelPrompt(conversationId)
  } catch {
    // Cancel is best-effort; the retry is what unblocks a racing next send.
  }
  await new Promise((resolve) => setTimeout(resolve, GROK_PROMPT_IN_FLIGHT_RETRY_MS))
  if (signal?.aborted) {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    throw abortError
  }
  yield* client.prompt(conversationId, body, signal)
}

function grokPromptText(
  db: Database.Database,
  trigger: MessageRow,
  currentBotId: string | null,
): string {
  const bots = botSummariesForMessages(db, [trigger])
  return mapDelegationForHermes(
    {
      role: trigger.role,
      content: trigger.content,
      kind: trigger.kind,
      from_bot_id: trigger.from_bot_id,
      to_bot_id: trigger.to_bot_id,
      from_bot: trigger.from_bot_id ? bots.get(trigger.from_bot_id) ?? null : null,
      to_bot: trigger.to_bot_id ? bots.get(trigger.to_bot_id) ?? null : null,
    },
    currentBotId,
  ).content
}

function grokRunWasInterrupted(
  input: Pick<ExecuteAssistantRunInput, 'conversationId' | 'abortRegistry'> & {
    abortSignal?: AbortSignal
  },
): boolean {
  return Boolean(
    input.abortSignal?.aborted && input.abortRegistry?.reason(input.conversationId) === 'interrupt',
  )
}

async function recoverGrokTurnFromOutbox(
  input: ExecuteAssistantRunInput & {
    runId: string
    streamCtx: RunEventContext
    abortSignal?: AbortSignal
  },
  catalog: CuratedModelEntry[],
): Promise<string | 'interrupted' | null> {
  if (grokRunWasInterrupted(input)) {
    return 'interrupted'
  }

  const grokClient = input.grokGatewayClient ?? createGrokGatewayClient('', '')
  const result = await drainGrokOutbox({
    db: input.db,
    client: grokClient,
    hub: input.hub,
    conversationId: input.conversationId,
    userId: input.userId,
    hermesSessionId: input.hermesSessionId,
    companionModels: catalog,
    runId: input.runId,
    originSessionId: input.originSessionId,
    abortSignal: input.abortSignal,
    isInterrupt: () => grokRunWasInterrupted(input),
    onAssistantMessageCommitted: input.onAssistantMessageCommitted,
    log: input.log,
  })

  if (result.status === 'persisted') {
    return result.messageId
  }
  if (result.status === 'interrupted') {
    return 'interrupted'
  }
  if (result.status === 'error') {
    throw new GrokGatewayError('grok_unavailable', result.error)
  }

  return null
}