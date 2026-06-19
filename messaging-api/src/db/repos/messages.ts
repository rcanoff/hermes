import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { touchConversationUpdatedAt, type ListPageAnchors } from './conversations.js'

export interface InsertMessageInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
}

export interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface MessagePage {
  messages: MessageRow[]
  hasOlder: boolean
  hasNewer: boolean
}

interface MessageCursorRow extends MessageRow {
  rowid: number
}

export const DUPLICATE_MESSAGE_WINDOW_SECONDS = 60

export function findRecentDuplicateUserMessage(
  db: Database.Database,
  conversationId: string,
  content: string,
  windowSeconds = DUPLICATE_MESSAGE_WINDOW_SECONDS,
): MessageRow | undefined {
  return db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at
      FROM messages
      WHERE conversation_id = ?
        AND role = 'user'
        AND content = ?
        AND created_at >= datetime('now', '-' || ? || ' seconds')
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `)
    .get(conversationId, content, windowSeconds) as MessageRow | undefined
}

export function insertMessage(db: Database.Database, input: InsertMessageInput): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content)
    VALUES (?, ?, ?, ?)
  `).run(id, input.conversationId, input.role, input.content)
  touchConversationUpdatedAt(db, input.conversationId)
  return id
}

export function listMessages(db: Database.Database, conversationId: string): MessageRow[] {
  return db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, rowid ASC
    `)
    .all(conversationId) as MessageRow[]
}

export function listMessagesPage(
  db: Database.Database,
  conversationId: string,
  limit: number,
  anchors: ListPageAnchors = {},
): MessagePage | null {
  if (anchors.before) {
    const cursor = getMessageCursor(db, conversationId, anchors.before)
    if (!cursor) {
      return null
    }

    const messages = db
      .prepare(`
        SELECT id, conversation_id, role, content, created_at
        FROM messages
        WHERE conversation_id = ?
          AND (
            created_at < ?
            OR (created_at = ? AND rowid < ?)
          )
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(conversationId, cursor.created_at, cursor.created_at, cursor.rowid, limit) as MessageRow[]

    messages.reverse()
    return buildMessagePage(db, conversationId, messages)
  }

  if (anchors.after) {
    const cursor = getMessageCursor(db, conversationId, anchors.after)
    if (!cursor) {
      return null
    }

    const messages = db
      .prepare(`
        SELECT id, conversation_id, role, content, created_at
        FROM messages
        WHERE conversation_id = ?
          AND (
            created_at > ?
            OR (created_at = ? AND rowid > ?)
          )
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `)
      .all(conversationId, cursor.created_at, cursor.created_at, cursor.rowid, limit) as MessageRow[]

    return buildMessagePage(db, conversationId, messages)
  }

  const messages = db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(conversationId, limit) as MessageRow[]

  messages.reverse()
  return buildMessagePage(db, conversationId, messages)
}

export function getMessage(
  db: Database.Database,
  conversationId: string,
  messageId: string,
): MessageRow | undefined {
  return db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at
      FROM messages
      WHERE conversation_id = ? AND id = ?
    `)
    .get(conversationId, messageId) as MessageRow | undefined
}

export function updateMessageContent(
  db: Database.Database,
  conversationId: string,
  messageId: string,
  content: string,
): MessageRow | undefined {
  db.prepare(`
    UPDATE messages
    SET content = ?
    WHERE conversation_id = ? AND id = ? AND role = 'user'
  `).run(content, conversationId, messageId)

  touchConversationUpdatedAt(db, conversationId)
  return getMessage(db, conversationId, messageId)
}

export function deleteMessage(db: Database.Database, conversationId: string, messageId: string): void {
  db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ? AND id = ?
  `).run(conversationId, messageId)
}

function getMessageCursor(
  db: Database.Database,
  conversationId: string,
  messageId: string,
): MessageCursorRow | undefined {
  return db
    .prepare(`
      SELECT rowid, id, conversation_id, role, content, created_at
      FROM messages
      WHERE conversation_id = ? AND id = ?
    `)
    .get(conversationId, messageId) as MessageCursorRow | undefined
}

function buildMessagePage(
  db: Database.Database,
  conversationId: string,
  messages: MessageRow[],
): MessagePage {
  if (messages.length === 0) {
    return {
      messages,
      hasOlder: false,
      hasNewer: false,
    }
  }

  const first = getMessageCursor(db, conversationId, messages[0]!.id)!
  const last = getMessageCursor(db, conversationId, messages[messages.length - 1]!.id)!

  const hasOlder = db
    .prepare(`
      SELECT 1
      FROM messages
      WHERE conversation_id = ?
        AND (
          created_at < ?
          OR (created_at = ? AND rowid < ?)
        )
      LIMIT 1
    `)
    .get(conversationId, first.created_at, first.created_at, first.rowid) as { 1: number } | undefined

  const hasNewer = db
    .prepare(`
      SELECT 1
      FROM messages
      WHERE conversation_id = ?
        AND (
          created_at > ?
          OR (created_at = ? AND rowid > ?)
        )
      LIMIT 1
    `)
    .get(conversationId, last.created_at, last.created_at, last.rowid) as { 1: number } | undefined

  return {
    messages,
    hasOlder: hasOlder !== undefined,
    hasNewer: hasNewer !== undefined,
  }
}