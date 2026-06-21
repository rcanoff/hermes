import type Database from 'better-sqlite3'
import { rotateHermesSessionId } from '../db/repos/conversations.js'
import {
  deleteMessage,
  listMessages,
  type MessageRow,
  updateMessageContent,
} from '../db/repos/messages.js'
import { createRun, deleteRunsForUserMessage } from '../db/repos/runs.js'
import { enrichMessageWithAttachments } from '../lib/attachment-serializer.js'
import {
  emitConversationMessageUpsert,
  emitConversationMessagesRewound,
} from './chat-sync-emitter.js'

export type MessageEditErrorCode = 'edit_not_allowed' | 'not_found'

export class MessageEditError extends Error {
  constructor(readonly code: MessageEditErrorCode) {
    super(code)
  }
}

export interface ApplyMessageEditResult {
  message: MessageRow
  runId: string
  removedAssistantMessageId: string
  hermesSessionId: string
}

export function findEditablePair(
  messages: MessageRow[],
  messageId: string,
): { userMessage: MessageRow; assistantMessage: MessageRow } {
  const target = messages.find((message) => message.id === messageId)
  if (!target) {
    throw new MessageEditError('not_found')
  }

  if (messages.length < 2) {
    throw new MessageEditError('edit_not_allowed')
  }

  const assistantMessage = messages[messages.length - 1]
  const userMessage = messages[messages.length - 2]

  if (
    userMessage.id !== messageId ||
    userMessage.role !== 'user' ||
    assistantMessage.role !== 'assistant'
  ) {
    throw new MessageEditError('edit_not_allowed')
  }

  return { userMessage, assistantMessage }
}

export function applyMessageEdit(
  db: Database.Database,
  userId: string,
  conversationId: string,
  messageId: string,
  content: string,
  originSessionId: string,
): ApplyMessageEditResult {
  const messages = listMessages(db, conversationId)
  const { assistantMessage } = findEditablePair(messages, messageId)

  return db.transaction(() => {
    deleteRunsForUserMessage(db, conversationId, messageId)
    deleteMessage(db, conversationId, assistantMessage.id)

    const message = updateMessageContent(db, conversationId, messageId, content)
    if (!message) {
      throw new MessageEditError('not_found')
    }

    const hermesSessionId = rotateHermesSessionId(db, conversationId)
    const runId = createRun(db, conversationId, messageId, originSessionId)

    emitConversationMessagesRewound(db, userId, conversationId, [assistantMessage.id])
    emitConversationMessageUpsert(db, userId, conversationId, enrichMessageWithAttachments(db, message))

    return {
      message,
      runId,
      removedAssistantMessageId: assistantMessage.id,
      hermesSessionId,
    }
  })()
}