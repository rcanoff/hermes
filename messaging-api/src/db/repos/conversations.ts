import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
} from '../../lib/companion-models.js'
import { buildJobConversationBootstrap } from '../../lib/job-conversation.js'

export type ConversationKind = 'regular' | 'job'

export interface ConversationRow {
  id: string
  user_id: string
  hermes_session_id: string
  kind: ConversationKind
  title: string | null
  bootstrap_prompt: string | null
  hermes_job_id: string | null
  schedule_display: string | null
  job_enabled: number
  job_last_run_at: string | null
  job_last_status: string | null
  model: string
  provider: string
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

export interface ListConversationsFilter {
  kind?: ConversationKind
}

const CONVERSATION_COLUMNS = `
  id, user_id, hermes_session_id, kind, title, bootstrap_prompt,
  hermes_job_id, schedule_display, job_enabled, job_last_run_at, job_last_status,
  model, provider, created_at, updated_at
`

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
  modelProvider?: { model: string; provider: string },
): string {
  const model = modelProvider?.model ?? COMPANION_DEFAULT_MODEL
  const provider = modelProvider?.provider ?? COMPANION_DEFAULT_PROVIDER
  const id = randomUUID()
  db.prepare(`
    INSERT INTO conversations (
      id, user_id, hermes_session_id, bootstrap_prompt, model, provider, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, userId, hermesSessionId, bootstrapPrompt ?? null, model, provider)
  return id
}

export function createJobConversation(
  db: Database.Database,
  userId: string,
  username: string,
  input: { name: string; scheduleDisplay?: string | null },
): string {
  const title = normalizeConversationTitle(input.name) ?? input.name.trim().slice(0, 120)
  const id = randomUUID()
  const hermesSessionId = randomUUID()

  db.prepare(`
    INSERT INTO conversations (
      id, user_id, hermes_session_id, kind, title, bootstrap_prompt,
      schedule_display, updated_at
    )
    VALUES (?, ?, ?, 'job', ?, ?, ?, datetime('now'))
  `).run(
    id,
    userId,
    hermesSessionId,
    title,
    buildJobConversationBootstrap(username),
    input.scheduleDisplay?.trim() || null,
  )

  return id
}

export function linkJobConversation(
  db: Database.Database,
  userId: string,
  input: {
    conversationId: string
    hermesJobId: string
    username: string
    scheduleDisplay?: string | null
    jobEnabled?: boolean
  },
): ConversationRow {
  const conversation = getConversationForUser(db, userId, input.conversationId)
  if (!conversation) {
    throw new Error('conversation_not_found')
  }
  if (conversation.kind !== 'job') {
    throw new Error('conversation_not_job')
  }
  if (conversation.hermes_job_id) {
    throw new Error('conversation_already_linked')
  }

  const existing = findConversationByHermesJobId(db, input.hermesJobId)
  if (existing) {
    throw new Error('hermes_job_id_already_linked')
  }

  const jobEnabled = input.jobEnabled === false ? 0 : 1
  const scheduleDisplay =
    input.scheduleDisplay !== undefined
      ? input.scheduleDisplay?.trim() || null
      : conversation.schedule_display

  const hermesJobId = input.hermesJobId.trim()
  const linkedBootstrap = buildJobConversationBootstrap(input.username, {
    hermesJobId,
    name: conversation.title,
    scheduleDisplay,
  })

  db.prepare(`
    UPDATE conversations
    SET hermes_job_id = ?,
        schedule_display = ?,
        job_enabled = ?,
        bootstrap_prompt = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(hermesJobId, scheduleDisplay, jobEnabled, linkedBootstrap, conversation.id)

  return getConversationForUser(db, userId, conversation.id)!
}

export function findConversationByHermesJobId(
  db: Database.Database,
  hermesJobId: string,
): ConversationRow | undefined {
  return db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM conversations
      WHERE hermes_job_id = ? AND kind = 'job'
    `)
    .get(hermesJobId.trim()) as ConversationRow | undefined
}

export function listConversations(db: Database.Database, userId: string): ConversationRow[] {
  return db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
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
  filter: ListConversationsFilter = {},
): ConversationPage | null {
  const kindClause = filter.kind ? 'AND kind = ?' : ''
  const kindParams = filter.kind ? [filter.kind] : []

  if (anchors.before) {
    const cursor = getConversationForUser(db, userId, anchors.before)
    if (!cursor || (filter.kind && cursor.kind !== filter.kind)) {
      return null
    }

    const conversations = db
      .prepare(`
        SELECT ${CONVERSATION_COLUMNS}
        FROM conversations
        WHERE user_id = ?
          ${kindClause}
          AND (
            updated_at < ?
            OR (updated_at = ? AND id < ?)
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)
      .all(userId, ...kindParams, cursor.updated_at, cursor.updated_at, cursor.id, limit) as ConversationRow[]

    return buildConversationPage(db, userId, conversations, filter)
  }

  if (anchors.after) {
    const cursor = getConversationForUser(db, userId, anchors.after)
    if (!cursor || (filter.kind && cursor.kind !== filter.kind)) {
      return null
    }

    const conversations = db
      .prepare(`
        SELECT ${CONVERSATION_COLUMNS}
        FROM conversations
        WHERE user_id = ?
          ${kindClause}
          AND (
            updated_at > ?
            OR (updated_at = ? AND id > ?)
          )
        ORDER BY updated_at ASC, id ASC
        LIMIT ?
      `)
      .all(userId, ...kindParams, cursor.updated_at, cursor.updated_at, cursor.id, limit) as ConversationRow[]

    conversations.reverse()
    return buildConversationPage(db, userId, conversations, filter)
  }

  const conversations = db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM conversations
      WHERE user_id = ?
        ${kindClause}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(userId, ...kindParams, limit) as ConversationRow[]

  return buildConversationPage(db, userId, conversations, filter)
}

export function getConversationForUser(
  db: Database.Database,
  userId: string,
  conversationId: string,
): ConversationRow | undefined {
  return db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
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

  if (result.changes === 1) {
    touchConversationUpdatedAt(db, conversationId)
  }

  return result.changes === 1
}

export function replaceConversationTitleIfEquals(
  db: Database.Database,
  conversationId: string,
  expectedTitle: string,
  newTitle: string,
): boolean {
  const result = db
    .prepare(`
      UPDATE conversations
      SET title = ?
      WHERE id = ? AND title = ?
    `)
    .run(newTitle, conversationId, expectedTitle)

  if (result.changes === 1) {
    touchConversationUpdatedAt(db, conversationId)
  }

  return result.changes === 1
}

export function updateConversationModel(
  db: Database.Database,
  conversationId: string,
  model: string,
  provider: string,
): ConversationRow | undefined {
  db.prepare(`
    UPDATE conversations
    SET model = ?, provider = ?
    WHERE id = ?
  `).run(model, provider, conversationId)

  touchConversationUpdatedAt(db, conversationId)

  return db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM conversations
      WHERE id = ?
    `)
    .get(conversationId) as ConversationRow | undefined
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

  touchConversationUpdatedAt(db, conversationId)

  return db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
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
  filter: ListConversationsFilter = {},
): ConversationPage {
  if (conversations.length === 0) {
    return {
      conversations,
      hasOlder: false,
      hasNewer: false,
    }
  }

  const kindClause = filter.kind ? 'AND kind = ?' : ''
  const kindParams = filter.kind ? [filter.kind] : []

  const first = conversations[0]!
  const last = conversations[conversations.length - 1]!

  const hasNewer = db
    .prepare(`
      SELECT 1
      FROM conversations
      WHERE user_id = ?
        ${kindClause}
        AND (
          updated_at > ?
          OR (updated_at = ? AND id > ?)
        )
      LIMIT 1
    `)
    .get(userId, ...kindParams, first.updated_at, first.updated_at, first.id) as { 1: number } | undefined

  const hasOlder = db
    .prepare(`
      SELECT 1
      FROM conversations
      WHERE user_id = ?
        ${kindClause}
        AND (
          updated_at < ?
          OR (updated_at = ? AND id < ?)
        )
      LIMIT 1
    `)
    .get(userId, ...kindParams, last.updated_at, last.updated_at, last.id) as { 1: number } | undefined

  return {
    conversations,
    hasOlder: hasOlder !== undefined,
    hasNewer: hasNewer !== undefined,
  }
}