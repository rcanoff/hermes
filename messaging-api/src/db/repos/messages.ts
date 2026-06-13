import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

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

export function insertMessage(db: Database.Database, input: InsertMessageInput): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content)
    VALUES (?, ?, ?, ?)
  `).run(id, input.conversationId, input.role, input.content)
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

  return getMessage(db, conversationId, messageId)
}

export function deleteMessage(db: Database.Database, conversationId: string, messageId: string): void {
  db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ? AND id = ?
  `).run(conversationId, messageId)
}
