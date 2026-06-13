import type Database from 'better-sqlite3'
import { getConversationLocation } from '../db/repos/locations.js'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { createRun, markRunCompleted, markRunFailed } from '../db/repos/runs.js'
import type { StreamHub } from '../streams/hub.js'
import { buildHermesMessages } from './prompt-builder.js'
import type { HermesClient } from './hermes-client.js'

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
  const location = getConversationLocation(input.db, input.conversationId)
  const hermesMessages = buildHermesMessages(history, location)

  let assistantText = ''
  let sawDone = false

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
      if (event.type === 'token' && event.text) {
        assistantText += event.text
        input.hub.publish(input.conversationId, { event: 'token', data: { text: event.text } })
      }

      if (event.type === 'tool' && event.name) {
        input.hub.publish(input.conversationId, { event: 'tool', data: { name: event.name } })
      }

      if (event.type === 'done') {
        sawDone = true
      }
    }

    if (!sawDone) {
      throw new Error('Hermes stream ended without a done event')
    }

    const assistantMessageId = persistCompletedRun(input.db, runId, input.conversationId, assistantText)
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
): string {
  return db.transaction(() => {
    const assistantMessageId = insertMessage(db, {
      conversationId,
      role: 'assistant',
      content: assistantText,
    })

    if (!markRunCompleted(db, runId, assistantMessageId)) {
      throw new Error('run_not_running')
    }

    return assistantMessageId
  })()
}
