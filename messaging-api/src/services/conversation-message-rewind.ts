import type Database from 'better-sqlite3'
import { rotateHermesSessionId } from '../db/repos/conversations.js'
import { type MessageRow } from '../db/repos/messages.js'
import { getActiveRun } from '../db/repos/runs.js'
import { emitConversationMessagesRewound } from './chat-sync-emitter.js'

export type MessageRewindErrorCode = 'not_found' | 'run_conflict'

export class MessageRewindError extends Error {
  constructor(readonly code: MessageRewindErrorCode) {
    super(code)
  }
}

export interface RemoveConversationMessagesResult {
  removedMessageIds: string[]
  hermesSessionId: string
}

interface MessageAnchorRow extends MessageRow {
  rowid: number
}

export function listMessagesFromAnchor(
  db: Database.Database,
  conversationId: string,
  fromMessageId: string,
): MessageRow[] {
  const anchor = db
    .prepare(`
      SELECT rowid, id, conversation_id, role, content, created_at
      FROM messages
      WHERE conversation_id = ? AND id = ?
    `)
    .get(conversationId, fromMessageId) as MessageAnchorRow | undefined

  if (!anchor) {
    return []
  }

  return db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at
      FROM messages
      WHERE conversation_id = ?
        AND (created_at > ? OR (created_at = ? AND rowid >= ?))
      ORDER BY created_at ASC, rowid ASC
    `)
    .all(conversationId, anchor.created_at, anchor.created_at, anchor.rowid) as MessageRow[]
}

export function removeConversationMessagesFrom(
  db: Database.Database,
  userId: string,
  conversationId: string,
  fromMessageId: string,
): RemoveConversationMessagesResult {
  const toRemove = listMessagesFromAnchor(db, conversationId, fromMessageId)
  if (toRemove.length === 0) {
    throw new MessageRewindError('not_found')
  }

  const removedMessageIds = toRemove.map((message) => message.id)
  const activeRun = getActiveRun(db, conversationId)
  if (
    activeRun &&
    (removedMessageIds.includes(activeRun.user_message_id) ||
      (activeRun.assistant_message_id != null &&
        removedMessageIds.includes(activeRun.assistant_message_id)))
  ) {
    throw new MessageRewindError('run_conflict')
  }

  return db.transaction(() => {
    deleteRunsReferencingMessages(db, conversationId, removedMessageIds)
    deleteMessagesByIds(db, conversationId, removedMessageIds)
    const hermesSessionId = rotateHermesSessionId(db, conversationId)
    emitConversationMessagesRewound(db, userId, conversationId, removedMessageIds)
    return { removedMessageIds, hermesSessionId }
  })()
}

function deleteRunsReferencingMessages(
  db: Database.Database,
  conversationId: string,
  messageIds: string[],
): void {
  if (messageIds.length === 0) {
    return
  }

  const placeholders = messageIds.map(() => '?').join(', ')
  db.prepare(`
    DELETE FROM message_runs
    WHERE conversation_id = ?
      AND (
        user_message_id IN (${placeholders})
        OR assistant_message_id IN (${placeholders})
      )
  `).run(conversationId, ...messageIds, ...messageIds)
}

function deleteMessagesByIds(
  db: Database.Database,
  conversationId: string,
  messageIds: string[],
): void {
  if (messageIds.length === 0) {
    return
  }

  const placeholders = messageIds.map(() => '?').join(', ')
  db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ?
      AND id IN (${placeholders})
  `).run(conversationId, ...messageIds)
}