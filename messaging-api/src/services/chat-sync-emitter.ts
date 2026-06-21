import type Database from 'better-sqlite3'
import {
  appendAccountConversationDeleted,
  appendAccountConversationUpsert,
  appendConversationConversationDeleted,
  appendConversationMessageUpsert,
  appendConversationMessagesRewound,
} from '../db/repos/chat-sync-events.js'
import { getConversationForUser } from '../db/repos/conversations.js'
import type { MessageWithAttachments } from '../lib/attachment-serializer.js'
import type { MessageProcess } from '../db/repos/process.js'
import { buildConversationSyncEntry } from '../lib/conversation-sync-entry.js'

export function emitAccountConversationUpsert(
  db: Database.Database,
  userId: string,
  conversationId: string,
): void {
  const conversation = getConversationForUser(db, userId, conversationId)
  if (!conversation) {
    return
  }

  appendAccountConversationUpsert(
    db,
    userId,
    conversationId,
    buildConversationSyncEntry(db, conversation),
  )
}

export function emitConversationMessageUpsert(
  db: Database.Database,
  userId: string,
  conversationId: string,
  message: MessageWithAttachments,
  process?: MessageProcess,
): void {
  appendConversationMessageUpsert(db, userId, conversationId, {
    ...message,
    ...(process ? { process } : {}),
  })
  emitAccountConversationUpsert(db, userId, conversationId)
}

export function emitConversationMessagesRewound(
  db: Database.Database,
  userId: string,
  conversationId: string,
  removedMessageIds: string[],
): void {
  if (removedMessageIds.length === 0) {
    return
  }

  appendConversationMessagesRewound(db, userId, conversationId, removedMessageIds)
  emitAccountConversationUpsert(db, userId, conversationId)
}

export function emitConversationDeleted(
  db: Database.Database,
  userId: string,
  conversationId: string,
): void {
  appendAccountConversationDeleted(db, userId, conversationId)
  appendConversationConversationDeleted(db, userId, conversationId)
}