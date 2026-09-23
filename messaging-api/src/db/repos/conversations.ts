import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
  DEFAULT_COMPANION_MODELS,
} from '../../lib/companion-models.js'
import { buildConversationSyncEntry } from '../../lib/conversation-sync-entry.js'
import { buildJobConversationBootstrap } from '../../lib/job-conversation.js'
import { enqueueConversationAttachments } from '../../services/attachment-cleanup.js'
import { ensureDefaultBotRow } from './bots.js'
import { listConversationBotIds, replaceConversationBots } from './conversation-bots.js'
import { addConversationMembers, removeConversationMembers } from './conversation-members.js'
import { cancelQueuedGroupRunsForBot } from './group-bot-runs.js'
import { appendAccountConversationUpsert } from './chat-sync-events.js'
import { findUserById } from './users.js'

export type ConversationKind = 'regular' | 'user_dm' | 'group' | 'job'

export const BOT_CHAT_TITLE = 'Bot Chat'

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
  bot_id: string | null
  peer_bot_id: string | null
  icon: string
  color: string
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
  botId?: string
  includeShared?: boolean
}

const CONVERSATION_COLUMNS = `
  conversations.id, conversations.user_id, conversations.hermes_session_id, conversations.kind,
  conversations.title, conversations.bootstrap_prompt, conversations.hermes_job_id,
  conversations.schedule_display, conversations.job_enabled, conversations.job_last_run_at,
  conversations.job_last_status, conversations.model, conversations.provider, conversations.bot_id,
  conversations.icon, conversations.color, conversations.peer_bot_id, conversations.created_at, conversations.updated_at
`

const MEMBERSHIP_JOIN = `
  INNER JOIN conversation_members
    ON conversation_members.conversation_id = conversations.id
   AND conversation_members.user_id = ?
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
  botId?: string,
): string {
  const model = modelProvider?.model ?? COMPANION_DEFAULT_MODEL
  const provider = modelProvider?.provider ?? COMPANION_DEFAULT_PROVIDER
  const resolvedBotId = botId ?? defaultBotId(db, userId)
  const id = randomUUID()
  db.prepare(`
    INSERT INTO conversations (
      id, user_id, hermes_session_id, bootstrap_prompt, model, provider, bot_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, userId, hermesSessionId, bootstrapPrompt ?? null, model, provider, resolvedBotId)
  return id
}

export function sharedConversationTitle(usernames: string[]): string {
  const names = [...usernames].sort()
  while (names.length > 1 && names.join(', ').length > 120) {
    names.pop()
  }
  return names.join(', ').slice(0, 120)
}

export function createOrOpenUserDm(
  db: Database.Database,
  callerId: string,
  peerId: string,
): { id: string; created: boolean } {
  const key = [callerId, peerId].sort().join(':')
  const existing = findUserDm(db, key)
  if (existing) {
    return { id: existing.id, created: false }
  }

  const id = randomUUID()
  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO conversations (
        id, user_id, hermes_session_id, kind, title, model, provider,
        bot_id, peer_bot_id, dm_key, updated_at
      )
      VALUES (?, ?, ?, 'user_dm', ?, ?, ?, NULL, NULL, ?, datetime('now'))
    `).run(
      id,
      callerId,
      randomUUID(),
      findUserById(db, peerId)?.username ?? '',
      COMPANION_DEFAULT_MODEL,
      COMPANION_DEFAULT_PROVIDER,
      key,
    )
    const row = getConversationById(db, id)!
    addConversationMembers(db, id, [callerId, peerId], row.created_at)
    const entry = buildConversationSyncEntry(db, row, DEFAULT_COMPANION_MODELS)
    appendAccountConversationUpsert(db, callerId, id, entry)
    appendAccountConversationUpsert(db, peerId, id, entry)
  })

  try {
    insert()
  } catch (error) {
    if (!isUniqueConstraint(error)) {
      throw error
    }
    const raced = findUserDm(db, key)
    if (!raced) {
      throw error
    }
    return { id: raced.id, created: false }
  }

  return { id, created: true }
}

export function createGroupConversation(
  db: Database.Database,
  input: { callerId: string; peerIds: string[]; botIds: string[]; title?: string; icon: string; color: string },
): string {
  const memberIds = [input.callerId, ...input.peerIds]
  const memberPlaceholders = memberIds.map(() => '?').join(', ')
  const people = db
    .prepare(`SELECT username FROM users WHERE id IN (${memberPlaceholders})`)
    .all(...memberIds) as Array<{ username: string }>
  const botNames =
    input.botIds.length === 0
      ? []
      : (
          db
            .prepare(`SELECT name FROM bots WHERE id IN (${input.botIds.map(() => '?').join(', ')})`)
            .all(...input.botIds) as Array<{ name: string }>
        ).map((bot) => bot.name)
  const id = randomUUID()
  const title = input.title?.trim() || sharedConversationTitle([...people.map((person) => person.username), ...botNames])

  db.transaction(() => {
    db.prepare(`
      INSERT INTO conversations (
        id, user_id, hermes_session_id, kind, title, model, provider,
        bot_id, icon, color, peer_bot_id, updated_at
      )
      VALUES (?, ?, ?, 'group', ?, ?, ?, NULL, ?, ?, NULL, datetime('now'))
    `).run(
      id,
      input.callerId,
      randomUUID(),
      title,
      COMPANION_DEFAULT_MODEL,
      COMPANION_DEFAULT_PROVIDER,
      input.icon,
      input.color,
    )
    const row = getConversationById(db, id)!
    addConversationMembers(db, id, memberIds, row.created_at)
    replaceConversationBots(db, id, input.botIds)
    const entry = buildConversationSyncEntry(db, row, DEFAULT_COMPANION_MODELS)
    for (const userId of memberIds) {
      appendAccountConversationUpsert(db, userId, id, entry)
    }
  })()

  return id
}

function findUserDm(db: Database.Database, dmKey: string): { id: string } | undefined {
  return db
    .prepare(`SELECT id FROM conversations WHERE kind = 'user_dm' AND dm_key = ?`)
    .get(dmKey) as { id: string } | undefined
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

export function findPeerConversation(
  db: Database.Database,
  userId: string,
  targetBotId: string,
  senderBotId: string,
): ConversationRow | undefined {
  return db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM conversations
      WHERE user_id = ?
        AND bot_id = ?
        AND peer_bot_id = ?
        AND kind = 'regular'
    `)
    .get(userId, targetBotId, senderBotId) as ConversationRow | undefined
}

export function findOrCreatePeerConversation(
  db: Database.Database,
  input: {
    userId: string
    targetBotId: string
    senderBotId: string
    senderName: string
  },
): ConversationRow {
  const existing = findPeerConversation(db, input.userId, input.targetBotId, input.senderBotId)
  if (existing) {
    return existing
  }

  const id = randomUUID()
  const hermesSessionId = randomUUID()
  const senderName = input.senderName.trim() || 'teammate'
  const title = `From ${senderName}`.slice(0, MAX_CONVERSATION_TITLE_CHARS)

  try {
    db.prepare(`
      INSERT INTO conversations (
        id, user_id, hermes_session_id, kind, title, bot_id, peer_bot_id, updated_at
      )
      VALUES (?, ?, ?, 'regular', ?, ?, ?, datetime('now'))
    `).run(id, input.userId, hermesSessionId, title, input.targetBotId, input.senderBotId)
  } catch (error) {
    const raced = findPeerConversation(db, input.userId, input.targetBotId, input.senderBotId)
    if (raced) {
      return raced
    }
    throw error
  }

  return getConversationForUser(db, input.userId, id)!
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

export const DEFAULT_RECENT_MODELS_LIMIT = 8

export function listRecentModelsForUser(
  db: Database.Database,
  userId: string,
  limit: number = DEFAULT_RECENT_MODELS_LIMIT,
): Array<{ model: string; provider: string }> {
  const rows = db
    .prepare(`
      SELECT model, provider
      FROM conversations
      WHERE user_id = ?
        AND kind = 'regular'
      ORDER BY updated_at DESC, id DESC
    `)
    .all(userId) as Array<{ model: string; provider: string }>

  const recents: Array<{ model: string; provider: string }> = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.model}\0${row.provider}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    recents.push({ model: row.model, provider: row.provider })
    if (recents.length >= limit) {
      break
    }
  }
  return recents
}

export function listConversationsReferencingBot(
  db: Database.Database,
  botId: string,
  userId: string,
): ConversationRow[] {
  return db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM conversations
      WHERE user_id = ?
        AND (bot_id = ? OR peer_bot_id = ?)
      ORDER BY updated_at DESC, id DESC
    `)
    .all(userId, botId, botId) as ConversationRow[]
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
  const { clause, params } = conversationFilterSql(filter)

  if (anchors.before) {
    const cursor = getConversationForUser(db, userId, anchors.before)
    if (!cursor || !conversationMatchesFilter(cursor, filter)) {
      return null
    }

    const conversations = db
      .prepare(`
        SELECT ${CONVERSATION_COLUMNS}
        FROM conversations
        ${MEMBERSHIP_JOIN}
        WHERE 1 = 1
          ${clause}
          AND (
            conversations.updated_at < ?
            OR (conversations.updated_at = ? AND conversations.id < ?)
          )
        ORDER BY conversations.updated_at DESC, conversations.id DESC
        LIMIT ?
      `)
      .all(userId, ...params, cursor.updated_at, cursor.updated_at, cursor.id, limit) as ConversationRow[]

    return buildConversationPage(db, userId, conversations, filter)
  }

  if (anchors.after) {
    const cursor = getConversationForUser(db, userId, anchors.after)
    if (!cursor || !conversationMatchesFilter(cursor, filter)) {
      return null
    }

    const conversations = db
      .prepare(`
        SELECT ${CONVERSATION_COLUMNS}
        FROM conversations
        ${MEMBERSHIP_JOIN}
        WHERE 1 = 1
          ${clause}
          AND (
            conversations.updated_at > ?
            OR (conversations.updated_at = ? AND conversations.id > ?)
          )
        ORDER BY conversations.updated_at ASC, conversations.id ASC
        LIMIT ?
      `)
      .all(userId, ...params, cursor.updated_at, cursor.updated_at, cursor.id, limit) as ConversationRow[]

    conversations.reverse()
    return buildConversationPage(db, userId, conversations, filter)
  }

  const conversations = db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM conversations
      ${MEMBERSHIP_JOIN}
      WHERE 1 = 1
        ${clause}
      ORDER BY conversations.updated_at DESC, conversations.id DESC
      LIMIT ?
    `)
    .all(userId, ...params, limit) as ConversationRow[]

  return buildConversationPage(db, userId, conversations, filter)
}

export function getConversationBotSlug(
  db: Database.Database,
  conversationId: string,
): string | undefined {
  const row = db
    .prepare(`
      SELECT bots.slug AS slug
      FROM conversations
      LEFT JOIN bots ON bots.id = conversations.bot_id
      WHERE conversations.id = ?
    `)
    .get(conversationId) as { slug: string | null } | undefined

  return row?.slug ?? undefined
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
      INNER JOIN conversation_members
        ON conversation_members.conversation_id = conversations.id
       AND conversation_members.user_id = ?
      WHERE conversations.id = ?
    `)
    .get(userId, conversationId) as ConversationRow | undefined
}

export function getConversationById(
  db: Database.Database,
  conversationId: string,
): ConversationRow | undefined {
  return db
    .prepare(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM conversations
      WHERE id = ?
    `)
    .get(conversationId) as ConversationRow | undefined
}

export function listGrokRuntimeConversations(db: Database.Database): ConversationRow[] {
  return db
    .prepare(`
      SELECT conversations.id, conversations.user_id, conversations.hermes_session_id,
        conversations.kind, conversations.title, conversations.bootstrap_prompt,
        conversations.hermes_job_id, conversations.schedule_display, conversations.job_enabled,
        conversations.job_last_run_at, conversations.job_last_status, conversations.model,
        conversations.provider, conversations.bot_id, conversations.peer_bot_id,
        conversations.created_at, conversations.updated_at
      FROM conversations
      INNER JOIN bots ON bots.id = conversations.bot_id
      WHERE bots.runtime = 'grok'
        AND conversations.kind NOT IN ('user_dm', 'group')
      ORDER BY conversations.updated_at DESC, conversations.id DESC
    `)
    .all() as ConversationRow[]
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

export function updateGroupSettings(
  db: Database.Database,
  conversationId: string,
  patch: {
    title?: string
    icon?: string
    color?: string
    botIds?: string[]
    addUserIds?: string[]
    removeUserIds?: string[]
  },
): ConversationRow | undefined {
  db.transaction(() => {
    const existing = getConversationById(db, conversationId)
    if (!existing) {
      return
    }

    const oldBotIds = listConversationBotIds(db, conversationId)
    const oldGeneratedTitle = sharedConversationTitle([
      ...groupHumanNames(db, conversationId),
      ...groupBotNames(db, oldBotIds),
    ])

    db.prepare(`
      UPDATE conversations
      SET title = COALESCE(?, title),
          icon = COALESCE(?, icon),
          color = COALESCE(?, color)
      WHERE id = ?
    `).run(patch.title ?? null, patch.icon ?? null, patch.color ?? null, conversationId)

    if (patch.addUserIds?.length) {
      addConversationMembers(db, conversationId, patch.addUserIds, existing.created_at)
    }
    if (patch.removeUserIds?.length) {
      removeConversationMembers(db, conversationId, patch.removeUserIds)
    }
    if (patch.botIds !== undefined) {
      replaceConversationBots(db, conversationId, patch.botIds)
    }

    const otherHumans = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_members
        WHERE conversation_id = ? AND user_id != ?
      `)
      .get(conversationId, existing.user_id) as { count: number }
    const botIds = listConversationBotIds(db, conversationId)
    if (otherHumans.count === 0 && botIds.length === 0) {
      throw new Error('empty_roster')
    }

    for (const botId of oldBotIds) {
      if (!botIds.includes(botId)) {
        cancelQueuedGroupRunsForBot(db, conversationId, botId)
      }
    }

    if (patch.title === undefined && existing.title === oldGeneratedTitle) {
      db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(
        sharedConversationTitle([...groupHumanNames(db, conversationId), ...groupBotNames(db, botIds)]),
        conversationId,
      )
    }
    touchConversationUpdatedAt(db, conversationId)
  })()
  return getConversationById(db, conversationId)
}

function groupHumanNames(db: Database.Database, conversationId: string): string[] {
  const rows = db
    .prepare(`
      SELECT users.username
      FROM conversation_members
      JOIN users ON users.id = conversation_members.user_id
      WHERE conversation_members.conversation_id = ?
    `)
    .all(conversationId) as Array<{ username: string }>
  return rows.map((row) => row.username)
}

function groupBotNames(db: Database.Database, botIds: string[]): string[] {
  if (botIds.length === 0) {
    return []
  }
  const rows = db
    .prepare(`SELECT name FROM bots WHERE id IN (${botIds.map(() => '?').join(', ')})`)
    .all(...botIds) as Array<{ name: string }>
  return rows.map((row) => row.name)
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
    enqueueConversationAttachments(db, conversationId)
    db.prepare('DELETE FROM message_runs WHERE conversation_id = ?').run(conversationId)
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
  })()

  return true
}

function defaultBotId(db: Database.Database, userId: string): string {
  return ensureDefaultBotRow(db, userId).id
}

export function getBotChatIdsByBot(
  db: Database.Database,
  userId: string,
  botIds: string[],
): Map<string, string> {
  const ids = new Map<string, string>()
  if (botIds.length === 0) {
    return ids
  }
  const placeholders = botIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `
      SELECT bot_id, id
      FROM conversations
      WHERE user_id = ?
        AND kind = 'regular'
        AND title = ?
        AND bot_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(userId, BOT_CHAT_TITLE, ...botIds) as Array<{ bot_id: string; id: string }>
  for (const row of rows) {
    if (row.bot_id && !ids.has(row.bot_id)) {
      ids.set(row.bot_id, row.id)
    }
  }
  return ids
}

function conversationFilterSql(filter: ListConversationsFilter): {
  clause: string
  params: string[]
} {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.includeShared && filter.kind === 'regular') {
    clauses.push(`AND conversations.kind IN ('regular', 'user_dm', 'group')`)
  } else if (filter.kind) {
    clauses.push('AND conversations.kind = ?')
    params.push(filter.kind)
  } else if (!filter.includeShared) {
    clauses.push(`AND conversations.kind IN ('regular', 'job')`)
  }
  if (filter.botId) {
    clauses.push('AND conversations.bot_id = ?')
    params.push(filter.botId)
  }
  return { clause: clauses.join(' '), params }
}

function conversationMatchesFilter(
  conversation: ConversationRow,
  filter: ListConversationsFilter,
): boolean {
  if (filter.includeShared && filter.kind === 'regular') {
    if (conversation.kind !== 'regular' && conversation.kind !== 'user_dm' && conversation.kind !== 'group') {
      return false
    }
  } else if (filter.kind && conversation.kind !== filter.kind) {
    return false
  } else if (!filter.includeShared && !filter.kind && conversation.kind !== 'regular' && conversation.kind !== 'job') {
    return false
  }
  if (filter.botId && conversation.bot_id !== filter.botId) {
    return false
  }
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

  const { clause, params } = conversationFilterSql(filter)

  const first = conversations[0]!
  const last = conversations[conversations.length - 1]!

  const hasNewer = db
    .prepare(`
      SELECT 1
      FROM conversations
      ${MEMBERSHIP_JOIN}
      WHERE 1 = 1
        ${clause}
        AND (
          conversations.updated_at > ?
          OR (conversations.updated_at = ? AND conversations.id > ?)
        )
      LIMIT 1
    `)
    .get(userId, ...params, first.updated_at, first.updated_at, first.id) as { 1: number } | undefined

  const hasOlder = db
    .prepare(`
      SELECT 1
      FROM conversations
      ${MEMBERSHIP_JOIN}
      WHERE 1 = 1
        ${clause}
        AND (
          conversations.updated_at < ?
          OR (conversations.updated_at = ? AND conversations.id < ?)
        )
      LIMIT 1
    `)
    .get(userId, ...params, last.updated_at, last.updated_at, last.id) as { 1: number } | undefined

  return {
    conversations,
    hasOlder: hasOlder !== undefined,
    hasNewer: hasNewer !== undefined,
  }
}