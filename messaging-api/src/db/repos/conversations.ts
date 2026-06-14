import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface ConversationRow {
  id: string
  user_id: string
  hermes_session_id: string
  title: string | null
  created_at: string
  updated_at: string
}

export function touchConversationUpdatedAt(db: Database.Database, conversationId: string): void {
  db.prepare(`
    UPDATE conversations
    SET updated_at = datetime('now')
    WHERE id = ?
  `).run(conversationId)
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
      SELECT id, user_id, hermes_session_id, title, created_at, updated_at
      FROM conversations
      WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC
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
      SELECT id, user_id, hermes_session_id, title, created_at, updated_at
      FROM conversations
      WHERE user_id = ? AND id = ?
    `)
    .get(userId, conversationId) as ConversationRow | undefined
}

const MAX_CONVERSATION_TITLE_CHARS = 120

export function normalizeConversationTitle(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_CONVERSATION_TITLE_CHARS) {
    return null
  }
  return trimmed
}

export function updateConversationTitleIfNull(
  db: Database.Database,
  conversationId: string,
  title: string,
): boolean {
  const result = db
    .prepare(`
      UPDATE conversations
      SET title = ?
      WHERE id = ? AND title IS NULL
    `)
    .run(title, conversationId)

  return result.changes === 1
}

export function updateConversationTitle(
  db: Database.Database,
  conversationId: string,
  title: string,
): ConversationRow | undefined {
  db.prepare(`
    UPDATE conversations
    SET title = ?
    WHERE id = ?
  `).run(title, conversationId)

  return db
    .prepare(`
      SELECT id, user_id, hermes_session_id, title, created_at, updated_at
      FROM conversations
      WHERE id = ?
    `)
    .get(conversationId) as ConversationRow | undefined
}

export function rotateHermesSessionId(db: Database.Database, conversationId: string): string {
  const hermesSessionId = randomUUID()
  db.prepare(`
    UPDATE conversations
    SET hermes_session_id = ?
    WHERE id = ?
  `).run(hermesSessionId, conversationId)
  return hermesSessionId
}

export function deleteConversationForUser(
  db: Database.Database,
  userId: string,
  conversationId: string,
): boolean {
  const conversation = getConversationForUser(db, userId, conversationId)
  if (!conversation) {
    return false
  }

  db.transaction(() => {
    db.prepare('DELETE FROM message_runs WHERE conversation_id = ?').run(conversationId)
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
  })()

  return true
}
