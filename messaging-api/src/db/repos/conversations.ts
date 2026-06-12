import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface ConversationRow {
  id: string
  user_id: string
  hermes_session_id: string
  title: string | null
  created_at: string
}

export function createConversation(db: Database.Database, userId: string, hermesSessionId: string): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO conversations (id, user_id, hermes_session_id)
    VALUES (?, ?, ?)
  `).run(id, userId, hermesSessionId)
  return id
}

export function listConversations(db: Database.Database, userId: string): ConversationRow[] {
  return db
    .prepare(`
      SELECT id, user_id, hermes_session_id, title, created_at
      FROM conversations
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
    `)
    .all(userId) as ConversationRow[]
}

export function getConversationForUser(
  db: Database.Database,
  userId: string,
  conversationId: string,
): ConversationRow | undefined {
  return db
    .prepare(`
      SELECT id, user_id, hermes_session_id, title, created_at
      FROM conversations
      WHERE user_id = ? AND id = ?
    `)
    .get(userId, conversationId) as ConversationRow | undefined
}
