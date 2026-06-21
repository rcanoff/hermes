import type Database from 'better-sqlite3'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { insertMessageProcess, type ToolingLine } from '../db/repos/process.js'
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
import { listAttachmentsForMessages } from '../db/repos/message-attachments.js'
import { buildHermesMessages } from './prompt-builder.js'
import type { HermesClient } from './hermes-client.js'
import {
  buildActivityLine,
  buildReasoningLine,
  buildStatusLine,
} from './tooling-line.js'
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
  attachmentsDir?: string
  visionHistoryMaxBytes?: number
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
  const attachmentMap = listAttachmentsForMessages(
    input.db,
    history.map((message) => message.id),
  )
  const historyWithAttachments = history.map((message) => ({
    ...message,
    attachments: attachmentMap.get(message.id),
  }))

  const streamCtx: RunEventContext = {
    hub: input.hub,
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
  let pendingStatusText: string | null = null
  let sawCronjobTool = false
  const knownJobIdsBefore = input.cronJobsPath
    ? await listHermesJobIdsFromFile(input.cronJobsPath)
    : new Set<string>()

  const publishProcessLine = (line: ToolingLine) => {
    processLines.push(line)
    sawToolingActivity = true
    publishToolingLine(streamCtx, line)
  }

  const flushPendingStatus = (tool: string) => {
    if (!pendingStatusText) {
      return
    }

    publishProcessLine(buildStatusLine({ text: pendingStatusText, tool }))
    pendingStatusText = null
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

  const flushPendingInstantReply = (options?: { persist?: boolean }) => {
    if (!pendingStatusText || sawFirstTool || inReplyPhase) {
      return
    }

    beginReplyPhase()
    if (options?.persist !== false) {
      assistantText += pendingStatusText
    }
    publishReplyToken(streamCtx, pendingStatusText)
    pendingStatusText = null
  }

  if (input.rewindMessageIds && input.rewindMessageIds.length > 0) {
    publishRewind(streamCtx, input.rewindMessageIds)
  }

  try {
    const hermesMessages = await buildHermesMessages(historyWithAttachments, {
      bootstrapPrompt: input.bootstrapPrompt,
      companionUsername: input.companionUsername,
      attachmentsDir: input.attachmentsDir,
      userId: input.userId,
      visionHistoryMaxBytes: input.visionHistoryMaxBytes,
    })

    for await (const event of input.hermesClient.streamChat({
      hermesSessionId: input.hermesSessionId,
      messages: hermesMessages,
    })) {
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
        flushPendingStatus(event.name)
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
          pendingStatusText = pendingStatusText == null ? event.text : pendingStatusText + event.text
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

    if (!sawDone) {
      throw new Error('Hermes stream ended without a done event')
    }

    flushPendingInstantReply()

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
    flushPendingInstantReply({ persist: false })
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
  processLines: ToolingLine[],
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