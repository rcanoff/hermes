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
      ORDER BY created_at ASC, id ASC
    `)
    .all(conversationId) as MessageRow[]
}
