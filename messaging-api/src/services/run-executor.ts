import type Database from 'better-sqlite3'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { insertMessageProcess, type ProcessLine } from '../db/repos/process.js'
import { createRun, markRunCompleted, markRunFailed } from '../db/repos/runs.js'
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
import { buildHermesMessages } from './prompt-builder.js'
import type { HermesClient } from './hermes-client.js'
import { formatToolProcessLine } from './process-labeler.js'
import { emitConversationMessageUpsert } from './chat-sync-emitter.js'
import { generateAndSaveTitle } from './title-generator.js'
import { listHermesJobIdsFromFile } from '../lib/hermes-cron-jobs.js'
import { autoLinkNewCompanionCronJobs } from './companion-cron-auto-link.js'

export interface ExecuteAssistantRunInput {
  db: Database.Database
  hermesClient: HermesClient
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
  shouldGenerateTitle?: boolean
  userMessageText?: string
  cronJobsPath?: string
  conversationTitle?: string | null
  onAssistantMessageCommitted?: (ctx: {
    messageId: string
    content: string
  }) => void | Promise<void>
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export async function executeAssistantRun(input: ExecuteAssistantRunInput): Promise<string> {
  const runId =
    input.runId ??
    createRun(input.db, input.conversationId, input.userMessageId, input.originSessionId ?? 'legacy')
  const history = listMessages(input.db, input.conversationId)
  const hermesMessages = buildHermesMessages(history, {
    bootstrapPrompt: input.bootstrapPrompt,
    companionUsername: input.companionUsername,
  })

  const streamCtx: RunEventContext = {
    hub: input.hub,
    conversationId: input.conversationId,
    runId,
    originSessionId: input.originSessionId,
  }

  let assistantText = ''
  let sawDone = false
  const processLines: ProcessLine[] = []
  let reasoningBuffer = ''
  let inReplyPhase = false
  let sawProcessActivity = false
  let sawCronjobTool = false
  const knownJobIdsBefore = input.cronJobsPath
    ? await listHermesJobIdsFromFile(input.cronJobsPath)
    : new Set<string>()

  const publishProcessLine = (line: ProcessLine) => {
    processLines.push(line)
    sawProcessActivity = true
    publishToolingLine(streamCtx, line)
  }

  const flushReasoningBuffer = () => {
    const text = reasoningBuffer.trim()
    reasoningBuffer = ''
    if (!text) {
      return
    }

    publishProcessLine({ kind: 'reasoning', text })
  }

  const beginReplyPhase = () => {
    if (inReplyPhase) {
      return
    }

    flushReasoningBuffer()
    inReplyPhase = true
    if (sawProcessActivity) {
      publishToolingComplete(streamCtx)
    }
  }

  if (input.rewindMessageIds && input.rewindMessageIds.length > 0) {
    publishRewind(streamCtx, input.rewindMessageIds)
  }

  try {
    for await (const event of input.hermesClient.streamChat({
      hermesSessionId: input.hermesSessionId,
      messages: hermesMessages,
    })) {
      if (event.type === 'reasoning' && event.text) {
        reasoningBuffer += event.text
        sawProcessActivity = true
        publishToolingDraft(streamCtx, event.text)
        continue
      }

      if (event.type === 'tool' && event.name) {
        flushReasoningBuffer()
        if (event.name === 'cronjob') {
          sawCronjobTool = true
        }
        const text = formatToolProcessLine(event.name, event.arguments, event.label)
        publishProcessLine({ kind: 'tool', text })
        continue
      }

      if (event.type === 'tool_complete') {
        if (event.name === 'cronjob') {
          sawCronjobTool = true
        }
        continue
      }

      if (event.type === 'answer_token' && event.text) {
        beginReplyPhase()
        assistantText += event.text
        publishReplyToken(streamCtx, event.text)
        continue
      }

      if (event.type === 'done') {
        sawDone = true
      }
    }

    if (!sawDone) {
      throw new Error('Hermes stream ended without a done event')
    }

    if (input.shouldGenerateTitle && input.userMessageText) {
      try {
        await generateAndSaveTitle({
          db: input.db,
          hermesClient: input.hermesClient,
          hub: input.hub,
          conversationId: input.conversationId,
          userId: input.userId,
          userMessageText: input.userMessageText,
          originSessionId: input.originSessionId,
        })
      } catch {
        // Title generation is best-effort; do not fail the assistant run.
      }
    }

    const assistantMessageId = persistCompletedRun(
      input.db,
      input.userId,
      runId,
      input.conversationId,
      assistantText,
      processLines,
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
    const message = error instanceof Error ? error.message : 'unknown'
    markRunFailed(input.db, runId, 'hermes_stream_failed', message)
    publishRunError(streamCtx, 'hermes_stream_failed')
    throw error
  }
}

function persistCompletedRun(
  db: Database.Database,
  userId: string,
  runId: string,
  conversationId: string,
  assistantText: string,
  processLines: ProcessLine[],
): string {
  return db.transaction(() => {
    const assistantMessageId = insertMessage(db, {
      conversationId,
      role: 'assistant',
      content: assistantText,
    })

    let process: { lines: ProcessLine[] } | undefined
    if (processLines.length > 0) {
      insertMessageProcess(db, {
        assistantMessageId,
        conversationId,
        lines: processLines,
      })
      process = { lines: processLines }
    }

    if (!markRunCompleted(db, runId, assistantMessageId)) {
      throw new Error('run_not_running')
    }

    const message = db
      .prepare(`
        SELECT id, conversation_id, role, content, created_at
        FROM messages
        WHERE conversation_id = ? AND id = ?
      `)
      .get(conversationId, assistantMessageId) as {
      id: string
      conversation_id: string
      role: 'user' | 'assistant'
      content: string
      created_at: string
    }

    emitConversationMessageUpsert(db, userId, conversationId, message, process)

    return assistantMessageId
  })()
}