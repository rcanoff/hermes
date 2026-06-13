import type Database from 'better-sqlite3'
import { getLatestLocationEvent } from '../db/repos/location-events.js'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { insertMessageProcess, type ProcessLine } from '../db/repos/process.js'
import { createRun, markRunCompleted, markRunFailed } from '../db/repos/runs.js'
import type { StreamHub } from '../streams/hub.js'
import { buildHermesMessages } from './prompt-builder.js'
import type { HermesClient } from './hermes-client.js'
import { formatToolProcessLine } from './process-labeler.js'

export interface ExecuteAssistantRunInput {
  db: Database.Database
  hermesClient: HermesClient
  hub: StreamHub
  conversationId: string
  hermesSessionId: string
  userMessageId: string
  runId?: string
  rewindMessageIds?: string[]
}

export async function executeAssistantRun(input: ExecuteAssistantRunInput): Promise<string> {
  const runId = input.runId ?? createRun(input.db, input.conversationId, input.userMessageId)
  const history = listMessages(input.db, input.conversationId)
  const location = getUserLocationContext(input.db, input.conversationId)
  const hermesMessages = buildHermesMessages(history, location)

  let assistantText = ''
  let sawDone = false
  const processLines: ProcessLine[] = []
  let inReplyPhase = false

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
      if (event.type === 'reasoning' && event.text?.trim()) {
        const line = { kind: 'reasoning' as const, text: event.text.trim() }
        processLines.push(line)
        input.hub.publish(input.conversationId, { event: 'process', data: line })
        continue
      }

      if (event.type === 'tool' && event.name) {
        const text = formatToolProcessLine(event.name, event.arguments)
        const line = { kind: 'tool' as const, text }
        processLines.push(line)
        input.hub.publish(input.conversationId, { event: 'process', data: line })
        continue
      }

      if (event.type === 'answer_token' && event.text) {
        if (!inReplyPhase) {
          inReplyPhase = true
          if (processLines.length > 0) {
            input.hub.publish(input.conversationId, { event: 'process_complete', data: {} })
          }
        }
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

    if (processLines.length > 0) {
      insertMessageProcess(db, {
        assistantMessageId,
        conversationId,
        lines: processLines,
      })
    }

    if (!markRunCompleted(db, runId, assistantMessageId)) {
      throw new Error('run_not_running')
    }

    return assistantMessageId
  })()
}

function getUserLocationContext(db: Database.Database, conversationId: string) {
  const conversation = db
    .prepare('SELECT user_id FROM conversations WHERE id = ?')
    .get(conversationId) as { user_id: string } | undefined

  if (!conversation) {
    return undefined
  }

  const event = getLatestLocationEvent(db, conversation.user_id)
  if (!event) {
    return undefined
  }

  return {
    lat: event.lat,
    lon: event.lon,
    accuracy_m: event.accuracy_m,
    timestamp: event.timestamp,
  }
}
