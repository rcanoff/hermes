import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface ConversationRow {
  id: string
  user_id: string
  hermes_session_id: string
  title: string | null
  bootstrap_prompt: string | null
  created_at: string
  updated_at: string
}

export interface ConversationPage {
  conversations: ConversationRow[]
  hasOlder: boolean
  hasNewer: boolean
}

export interface ListPageAnchors {
  before?: string
  after?: string
}

export function touchConversationUpdatedAt(db: Database.Database, conversationId: string): void {
  db.prepare(`
    UPDATE conversations
    SET updated_at = datetime('now')
    WHERE id = ?
  `).run(conversationId)
}

export function setBootstrapPrompt(
  db: Database.Database,
  conversationId: string,
  bootstrapPrompt: string,
): boolean {
  const result = db
    .prepare(`
      UPDATE conversations
      SET bootstrap_prompt = ?
      WHERE id = ?
        AND bootstrap_prompt IS NULL
    `)
    .run(bootstrapPrompt, conversationId)

  return result.changes === 1
}

export function createConversation(
  db: Database.Database,
  userId: string,
  hermesSessionId: string,
  bootstrapPrompt?: string | null,
): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO conversations (id, user_id, hermes_session_id, bootstrap_prompt, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, userId, hermesSessionId, bootstrapPrompt ?? null)
  return id
}

export function listConversations(db: Database.Database, userId: string): ConversationRow[] {
  return db
    .prepare(`
      SELECT id, user_id, hermes_session_id, title, bootstrap_prompt, created_at, updated_at
      FROM conversations
      WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(userId) as ConversationRow[]
}

export function listConversationsPage(
  db: Database.Database,
  userId: string,
  limit: number,
  anchors: ListPageAnchors = {},
): ConversationPage | null {
  if (anchors.before) {
    const cursor = getConversationForUser(db, userId, anchors.before)
    if (!cursor) {
      return null
    }

    const conversations = db
      .prepare(`
        SELECT id, user_id, hermes_session_id, title, bootstrap_prompt, created_at, updated_at
        FROM conversations
        WHERE user_id = ?
          AND (
            updated_at < ?
            OR (updated_at = ? AND id < ?)
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)
      .all(userId, cursor.updated_at, cursor.updated_at, cursor.id, limit) as ConversationRow[]

    return buildConversationPage(db, userId, conversations)
  }

  if (anchors.after) {
    const cursor = getConversationForUser(db, userId, anchors.after)
    if (!cursor) {
      return null
    }

    const conversations = db
      .prepare(`
        SELECT id, user_id, hermes_session_id, title, bootstrap_prompt, created_at, updated_at
        FROM conversations
        WHERE user_id = ?
          AND (
            updated_at > ?
            OR (updated_at = ? AND id > ?)
          )
        ORDER BY updated_at ASC, id ASC
        LIMIT ?
      `)
      .all(userId, cursor.updated_at, cursor.updated_at, cursor.id, limit) as ConversationRow[]

    conversations.reverse()
    return buildConversationPage(db, userId, conversations)
  }

  const conversations = db
    .prepare(`
      SELECT id, user_id, hermes_session_id, title, bootstrap_prompt, created_at, updated_at
      FROM conversations
      WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(userId, limit) as ConversationRow[]

  return buildConversationPage(db, userId, conversations)
}

export function getConversationForUser(
  db: Database.Database,
  userId: string,
  conversationId: string,
): ConversationRow | undefined {
  return db
    .prepare(`
      SELECT id, user_id, hermes_session_id, title, bootstrap_prompt, created_at, updated_at
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
      SELECT id, user_id, hermes_session_id, title, bootstrap_prompt, created_at, updated_at
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

function buildConversationPage(
  db: Database.Database,
  userId: string,
  conversations: ConversationRow[],
): ConversationPage {
  if (conversations.length === 0) {
    return {
      conversations,
      hasOlder: false,
      hasNewer: false,
    }
  }

  const first = conversations[0]!
  const last = conversations[conversations.length - 1]!

  const hasNewer = db
    .prepare(`
      SELECT 1
      FROM conversations
      WHERE user_id = ?
        AND (
          updated_at > ?
          OR (updated_at = ? AND id > ?)
        )
      LIMIT 1
    `)
    .get(userId, first.updated_at, first.updated_at, first.id) as { 1: number } | undefined

  const hasOlder = db
    .prepare(`
      SELECT 1
      FROM conversations
      WHERE user_id = ?
        AND (
          updated_at < ?
          OR (updated_at = ? AND id < ?)
        )
      LIMIT 1
    `)
    .get(userId, last.updated_at, last.updated_at, last.id) as { 1: number } | undefined

  return {
    conversations,
    hasOlder: hasOlder !== undefined,
    hasNewer: hasNewer !== undefined,
  }
}