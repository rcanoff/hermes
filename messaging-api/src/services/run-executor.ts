import type Database from 'better-sqlite3'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { insertMessageProcess, type ProcessLine } from '../db/repos/process.js'
import { createRun, markRunCompleted, markRunFailed } from '../db/repos/runs.js'
import type { StreamHub } from '../streams/hub.js'
import { buildHermesMessages } from './prompt-builder.js'
import type { HermesClient } from './hermes-client.js'
import { formatToolProcessLine } from './process-labeler.js'
import { emitConversationMessageUpsert } from './chat-sync-emitter.js'

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
}

export async function executeAssistantRun(input: ExecuteAssistantRunInput): Promise<string> {
  const runId = input.runId ?? createRun(input.db, input.conversationId, input.userMessageId)
  const history = listMessages(input.db, input.conversationId)
  const hermesMessages = buildHermesMessages(history, {
    bootstrapPrompt: input.bootstrapPrompt,
    companionUsername: input.companionUsername,
  })

  let assistantText = ''
  let sawDone = false
  const processLines: ProcessLine[] = []
  let reasoningBuffer = ''
  let inReplyPhase = false
  let sawProcessActivity = false

  const publishProcessLine = (line: ProcessLine) => {
    processLines.push(line)
    sawProcessActivity = true
    input.hub.publish(input.conversationId, { event: 'process', data: line })
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
      input.hub.publish(input.conversationId, { event: 'process_complete', data: {} })
    }
  }

  if (input.rewindMessageIds && input.rewindMessageIds.length > 0) {
    input.hub.setPendingRewind(input.conversationId, input.rewindMessageIds)
    input.hub.publish(input.conversationId, {
      event: 'rewind',
      data: { removedMessageIds: input.rewindMessageIds },
    })
  }

  try {
    for await (const event of input.hermesClient.streamChat({
      hermesSessionId: input.hermesSessionId,
      messages: hermesMessages,
    })) {
      if (event.type === 'reasoning' && event.text) {
        reasoningBuffer += event.text
        sawProcessActivity = true
        input.hub.publish(input.conversationId, {
          event: 'process_token',
          data: { kind: 'reasoning', text: event.text },
        })
        continue
      }

      if (event.type === 'tool' && event.name) {
        flushReasoningBuffer()
        const text = formatToolProcessLine(event.name, event.arguments, event.label)
        publishProcessLine({ kind: 'tool', text })
        continue
      }

      if (event.type === 'tool_complete' && event.name) {
        const text = formatToolProcessLine(event.name, event.arguments, event.label)
        publishProcessLine({ kind: 'tool', text: `Done: ${text}` })
        continue
      }

      if (event.type === 'answer_token' && event.text) {
        beginReplyPhase()
        assistantText += event.text
        input.hub.publish(input.conversationId, { event: 'token', data: { text: event.text } })
        continue
      }

      if (event.type === 'done') {
        sawDone = true
      }
    }

    if (!sawDone) {
      throw new Error('Hermes stream ended without a done event')
    }

    const assistantMessageId = persistCompletedRun(
      input.db,
      input.userId,
      runId,
      input.conversationId,
      assistantText,
      processLines,
    )
    input.hub.publish(input.conversationId, { event: 'done', data: { messageId: assistantMessageId } })
    return assistantMessageId
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown'
    markRunFailed(input.db, runId, 'hermes_stream_failed', message)
    input.hub.publish(input.conversationId, { event: 'error', data: { code: 'hermes_stream_failed' } })
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