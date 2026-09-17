import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  DEFAULT_BOT_COLOR,
  DEFAULT_BOT_ICON,
  type BotColor,
  type BotIcon,
} from '../../lib/bot-appearance.js'
import {
  DEFAULT_BOT_SLUG,
  addHonchoHost,
  createBotProfile,
  ensureSkillsOverlay,
  isOperatorOwner,
  profileRelativeKey,
  readSoulFile,
  type BotProfileOwner,
} from '../../lib/hermes-profile.js'
import { enqueueConversationAttachments } from '../../services/attachment-cleanup.js'
import { findUserById } from './users.js'
import type { ListPageAnchors } from './conversations.js'

export const DEFAULT_BOT_NAME = 'Hermes'
export const DEFAULT_BOT_ROLE = 'Default Companion assistant.'
export const DEFAULT_BOT_SOUL = 'You are Hermes Agent, the default Companion assistant.'
export const DEFAULT_BOT_RESPONSIBILITIES =
  'Default Companion assistant; routes matching work to specialist teammates.'
export const PATRIK_BOT_SLUG = 'patrik'
export const PATRIK_BOT_RESPONSIBILITIES =
  'Personal data: addresses, phone numbers, and things the user owns.'
export const MAX_BOT_RESPONSIBILITIES_CHARS = 200

export const BOT_RUNTIMES = ['hermes', 'grok'] as const
export type BotRuntime = (typeof BOT_RUNTIMES)[number]
export const DEFAULT_BOT_RUNTIME: BotRuntime = 'hermes'

const BOT_COLUMNS = `bots.id, bots.user_id, bots.slug, bots.name, bots.role, bots.soul, bots.responsibilities, bots.icon, bots.color, bots.runtime, bots.hermes_profile_name, bots.is_default, bots.created_at, users.username AS owner_username`
const BOT_FROM = `bots INNER JOIN users ON users.id = bots.user_id`

export interface BotRow {
  id: string
  user_id: string
  slug: string
  name: string
  role: string
  soul: string
  responsibilities: string
  icon: string
  color: string
  runtime: BotRuntime
  hermes_profile_name: string | null
  is_default: number
  created_at: string
  owner_username: string
}

export interface BotPage {
  bots: BotRow[]
  hasOlder: boolean
  hasNewer: boolean
}

export interface CreateBotInput {
  userId: string
  slug: string
  name: string
  role: string
  soul: string
  responsibilities?: string
  icon?: BotIcon
  color?: BotColor
  runtime?: BotRuntime
  hermesProfileName?: string | null
  isDefault?: boolean
}

export function isBotRuntime(value: unknown): value is BotRuntime {
  return value === 'hermes' || value === 'grok'
}

export function normalizeBotRuntime(value: string): BotRuntime {
  return value === 'grok' ? 'grok' : 'hermes'
}

export function botOwner(row: Pick<BotRow, 'user_id' | 'owner_username'>): BotProfileOwner {
  return { userId: row.user_id, username: row.owner_username }
}

export function ensureDefaultBotRow(
  db: Database.Database,
  userId: string,
  soul = DEFAULT_BOT_SOUL,
): BotRow {
  const existing = getBotBySlug(db, userId, DEFAULT_BOT_SLUG)
  if (existing) {
    return existing
  }

  return insertBot(db, {
    userId,
    slug: DEFAULT_BOT_SLUG,
    name: DEFAULT_BOT_NAME,
    role: DEFAULT_BOT_ROLE,
    soul,
    responsibilities: DEFAULT_BOT_RESPONSIBILITIES,
    isDefault: true,
  })
}

export function seedKnownBotResponsibilities(db: Database.Database): void {
  db.prepare(`
    UPDATE bots
    SET responsibilities = ?
    WHERE slug = ? AND TRIM(responsibilities) = ''
  `).run(DEFAULT_BOT_RESPONSIBILITIES, DEFAULT_BOT_SLUG)

  db.prepare(`
    UPDATE bots
    SET responsibilities = ?
    WHERE slug = ? AND TRIM(responsibilities) = ''
  `).run(PATRIK_BOT_RESPONSIBILITIES, PATRIK_BOT_SLUG)
}

export function seedDefaultBot(
  db: Database.Database,
  userId: string,
  hermesHome: string,
): BotRow {
  const user = findUserById(db, userId)
  if (!user) {
    throw new Error('user_missing')
  }

  const owner: BotProfileOwner = { userId: user.id, username: user.username }
  const existing = getBotBySlug(db, userId, DEFAULT_BOT_SLUG)
  if (existing) {
    seedKnownBotResponsibilities(db)
    if (!isOperatorOwner(owner)) {
      ensureUserDefaultProfile(hermesHome, owner, existing)
    }
    return getBotBySlug(db, userId, DEFAULT_BOT_SLUG)!
  }

  const soul = isOperatorOwner(owner)
    ? (readSoulFile(hermesHome, owner, DEFAULT_BOT_SLUG) ?? DEFAULT_BOT_SOUL)
    : DEFAULT_BOT_SOUL
  const row = ensureDefaultBotRow(db, userId, soul)
  if (!isOperatorOwner(owner)) {
    ensureUserDefaultProfile(hermesHome, owner, row)
  }
  return row
}

function ensureUserDefaultProfile(
  hermesHome: string,
  owner: BotProfileOwner,
  row: BotRow,
): void {
  if (readSoulFile(hermesHome, owner, DEFAULT_BOT_SLUG) !== null) {
    try {
      ensureSkillsOverlay(hermesHome, owner, DEFAULT_BOT_SLUG)
    } catch {
      // best-effort backfill; listing/seeding must not fail on overlay FS errors
    }
    return
  }
  createBotProfile({
    hermesHome,
    owner,
    slug: DEFAULT_BOT_SLUG,
    name: row.name,
    role: row.role,
    soul: row.soul,
  })
  addHonchoHost(hermesHome, owner, DEFAULT_BOT_SLUG)
}

export function insertBot(db: Database.Database, input: CreateBotInput): BotRow {
  const id = randomUUID()
  const runtime = input.runtime ?? DEFAULT_BOT_RUNTIME
  db.prepare(`
    INSERT INTO bots (id, user_id, slug, name, role, soul, responsibilities, icon, color, runtime, hermes_profile_name, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    input.slug,
    input.name,
    input.role,
    input.soul,
    input.responsibilities ?? '',
    input.icon ?? DEFAULT_BOT_ICON,
    input.color ?? DEFAULT_BOT_COLOR,
    runtime,
    input.hermesProfileName ?? null,
    input.isDefault ? 1 : 0,
  )

  return getBotById(db, id)!
}

export function getBotById(db: Database.Database, id: string): BotRow | undefined {
  return db
    .prepare(`SELECT ${BOT_COLUMNS} FROM ${BOT_FROM} WHERE bots.id = ?`)
    .get(id) as BotRow | undefined
}

export function getBotByIdForUser(
  db: Database.Database,
  userId: string,
  id: string,
): BotRow | undefined {
  return db
    .prepare(`SELECT ${BOT_COLUMNS} FROM ${BOT_FROM} WHERE bots.id = ? AND bots.user_id = ?`)
    .get(id, userId) as BotRow | undefined
}

export function getBotsByIds(db: Database.Database, ids: string[]): Map<string, BotRow> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))]
  const result = new Map<string, BotRow>()
  if (unique.length === 0) {
    return result
  }

  const placeholders = unique.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT ${BOT_COLUMNS} FROM ${BOT_FROM} WHERE bots.id IN (${placeholders})`)
    .all(...unique) as BotRow[]

  for (const row of rows) {
    result.set(row.id, row)
  }

  return result
}

export function getBotBySlug(
  db: Database.Database,
  userId: string,
  slug: string,
): BotRow | undefined {
  return db
    .prepare(`SELECT ${BOT_COLUMNS} FROM ${BOT_FROM} WHERE bots.user_id = ? AND bots.slug = ?`)
    .get(userId, slug) as BotRow | undefined
}

export function getGrokBot(db: Database.Database, userId: string): BotRow | undefined {
  return db
    .prepare(
      `SELECT ${BOT_COLUMNS} FROM ${BOT_FROM} WHERE bots.user_id = ? AND bots.runtime = 'grok' LIMIT 1`,
    )
    .get(userId) as BotRow | undefined
}

export function listBotsForRoster(db: Database.Database, userId: string): BotRow[] {
  return db
    .prepare(`
      SELECT ${BOT_COLUMNS}
      FROM ${BOT_FROM}
      WHERE bots.user_id = ?
      ORDER BY bots.is_default DESC, bots.name ASC, bots.id ASC
    `)
    .all(userId) as BotRow[]
}

export function updateBot(
  db: Database.Database,
  id: string,
  patch: {
    name?: string
    role?: string
    soul?: string
    responsibilities?: string
    icon?: BotIcon
    color?: BotColor
  },
): BotRow | undefined {
  const current = getBotById(db, id)
  if (!current) {
    return undefined
  }

  const name = patch.name ?? current.name
  const role = patch.role ?? current.role
  const soul = patch.soul ?? current.soul
  const responsibilities = patch.responsibilities ?? current.responsibilities
  const icon = patch.icon ?? current.icon
  const color = patch.color ?? current.color

  db.prepare(`
    UPDATE bots
    SET name = ?, role = ?, soul = ?, responsibilities = ?, icon = ?, color = ?
    WHERE id = ?
  `).run(name, role, soul, responsibilities, icon, color, id)

  return getBotById(db, id)
}

export function getBotNotificationsEnabled(
  db: Database.Database,
  userId: string,
  botId: string,
): boolean {
  const row = db
    .prepare(`
      SELECT notifications_enabled
      FROM user_bot_preferences
      WHERE user_id = ? AND bot_id = ?
    `)
    .get(userId, botId) as { notifications_enabled: number } | undefined

  return row ? row.notifications_enabled === 1 : true
}

export function upsertBotNotificationsEnabled(
  db: Database.Database,
  userId: string,
  botId: string,
  enabled: boolean,
): void {
  db.prepare(`
    INSERT INTO user_bot_preferences (user_id, bot_id, notifications_enabled, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, bot_id) DO UPDATE SET
      notifications_enabled = excluded.notifications_enabled,
      updated_at = datetime('now')
  `).run(userId, botId, enabled ? 1 : 0)
}

export function getBotNotificationsEnabledMap(
  db: Database.Database,
  userId: string,
  botIds: string[],
): Map<string, boolean> {
  const result = new Map<string, boolean>()
  for (const botId of botIds) {
    result.set(botId, true)
  }

  if (botIds.length === 0) {
    return result
  }

  const placeholders = botIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      SELECT bot_id, notifications_enabled
      FROM user_bot_preferences
      WHERE user_id = ? AND bot_id IN (${placeholders})
    `)
    .all(userId, ...botIds) as Array<{ bot_id: string; notifications_enabled: number }>

  for (const row of rows) {
    result.set(row.bot_id, row.notifications_enabled === 1)
  }

  return result
}

export type BotLastActivity = {
  last_message_at: string | null
  last_message: string | null
}

export function getBotLastActivityMap(
  db: Database.Database,
  userId: string,
  botIds: string[],
): Map<string, BotLastActivity> {
  const result = new Map<string, BotLastActivity>()
  for (const botId of botIds) {
    result.set(botId, { last_message_at: null, last_message: null })
  }

  if (botIds.length === 0) {
    return result
  }

  const placeholders = botIds.map(() => '?').join(', ')
  const times = db
    .prepare(`
      SELECT bot_id, MAX(updated_at) AS last_message_at
      FROM conversations
      WHERE user_id = ?
        AND kind = 'regular'
        AND bot_id IN (${placeholders})
      GROUP BY bot_id
    `)
    .all(userId, ...botIds) as Array<{ bot_id: string; last_message_at: string | null }>

  for (const row of times) {
    const current = result.get(row.bot_id)
    if (current) {
      current.last_message_at = row.last_message_at
    }
  }

  const previews = db
    .prepare(`
      SELECT bot_id, content AS last_message
      FROM (
        SELECT
          c.bot_id AS bot_id,
          m.content AS content,
          ROW_NUMBER() OVER (
            PARTITION BY c.bot_id
            ORDER BY m.created_at DESC, m.rowid DESC
          ) AS rn
        FROM conversations c
        INNER JOIN messages m ON m.conversation_id = c.id
        WHERE c.user_id = ?
          AND c.kind = 'regular'
          AND c.bot_id IN (${placeholders})
          AND m.kind != 'pending_input'
          AND TRIM(m.content) != ''
      )
      WHERE rn = 1
    `)
    .all(userId, ...botIds) as Array<{ bot_id: string; last_message: string }>

  for (const row of previews) {
    const current = result.get(row.bot_id)
    if (current) {
      current.last_message = row.last_message
    }
  }

  return result
}

export function deleteBot(db: Database.Database, id: string, userId: string): boolean {
  return db.transaction(() => {
    const conversationIds = db
      .prepare(
        `SELECT id FROM conversations WHERE user_id = ? AND (bot_id = ? OR peer_bot_id = ?)`,
      )
      .all(userId, id, id) as Array<{ id: string }>

    for (const row of conversationIds) {
      enqueueConversationAttachments(db, row.id)
      db.prepare('DELETE FROM message_runs WHERE conversation_id = ?').run(row.id)
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(row.id)
      db.prepare('DELETE FROM conversations WHERE id = ?').run(row.id)
    }

    db.prepare(`UPDATE conversations SET bot_id = NULL WHERE bot_id = ? AND user_id != ?`).run(
      id,
      userId,
    )
    db.prepare(
      `UPDATE conversations SET peer_bot_id = NULL WHERE peer_bot_id = ? AND user_id != ?`,
    ).run(id, userId)

    db.prepare('UPDATE messages SET from_bot_id = NULL WHERE from_bot_id = ?').run(id)
    db.prepare('UPDATE messages SET to_bot_id = NULL WHERE to_bot_id = ?').run(id)

    const result = db.prepare(`DELETE FROM bots WHERE id = ? AND user_id = ?`).run(id, userId)
    return result.changes === 1
  })()
}

export function listBotsPage(
  db: Database.Database,
  userId: string,
  limit: number,
  anchors: ListPageAnchors = {},
): BotPage | null {
  if (anchors.before) {
    const cursor = getBotByIdForUser(db, userId, anchors.before)
    if (!cursor) {
      return null
    }

    const bots = db
      .prepare(`
        SELECT ${BOT_COLUMNS}
        FROM ${BOT_FROM}
        WHERE
          bots.user_id = ?
          AND (
            bots.is_default < ?
            OR (bots.is_default = ? AND bots.created_at < ?)
            OR (bots.is_default = ? AND bots.created_at = ? AND bots.id < ?)
          )
        ORDER BY bots.is_default DESC, bots.created_at DESC, bots.id DESC
        LIMIT ?
      `)
      .all(
        userId,
        cursor.is_default,
        cursor.is_default,
        cursor.created_at,
        cursor.is_default,
        cursor.created_at,
        cursor.id,
        limit,
      ) as BotRow[]

    return buildBotPage(db, userId, bots)
  }

  if (anchors.after) {
    const cursor = getBotByIdForUser(db, userId, anchors.after)
    if (!cursor) {
      return null
    }

    const bots = db
      .prepare(`
        SELECT ${BOT_COLUMNS}
        FROM ${BOT_FROM}
        WHERE
          bots.user_id = ?
          AND (
            bots.is_default > ?
            OR (bots.is_default = ? AND bots.created_at > ?)
            OR (bots.is_default = ? AND bots.created_at = ? AND bots.id > ?)
          )
        ORDER BY bots.is_default ASC, bots.created_at ASC, bots.id ASC
        LIMIT ?
      `)
      .all(
        userId,
        cursor.is_default,
        cursor.is_default,
        cursor.created_at,
        cursor.is_default,
        cursor.created_at,
        cursor.id,
        limit,
      ) as BotRow[]

    bots.reverse()
    return buildBotPage(db, userId, bots)
  }

  const bots = db
    .prepare(`
      SELECT ${BOT_COLUMNS}
      FROM ${BOT_FROM}
      WHERE bots.user_id = ?
      ORDER BY bots.is_default DESC, bots.created_at DESC, bots.id DESC
      LIMIT ?
    `)
    .all(userId, limit) as BotRow[]

  return buildBotPage(db, userId, bots)
}

export function soulForResponse(row: BotRow, hermesHome: string): string {
  if (normalizeBotRuntime(row.runtime) === 'grok') {
    return row.soul
  }
  return readSoulFile(hermesHome, botOwner(row), row.slug) ?? row.soul
}

export function hermesProfileKeyForBot(row: BotRow, hermesHome?: string): string | undefined {
  return profileRelativeKey(botOwner(row), row.slug, hermesHome) ?? undefined
}

function buildBotPage(db: Database.Database, userId: string, bots: BotRow[]): BotPage {
  if (bots.length === 0) {
    return {
      bots,
      hasOlder: false,
      hasNewer: false,
    }
  }

  const first = bots[0]!
  const last = bots[bots.length - 1]!

  const hasNewer = db
    .prepare(`
      SELECT 1
      FROM bots
      WHERE
        user_id = ?
        AND (
          is_default > ?
          OR (is_default = ? AND created_at > ?)
          OR (is_default = ? AND created_at = ? AND id > ?)
        )
      LIMIT 1
    `)
    .get(
      userId,
      first.is_default,
      first.is_default,
      first.created_at,
      first.is_default,
      first.created_at,
      first.id,
    ) as { 1: number } | undefined

  const hasOlder = db
    .prepare(`
      SELECT 1
      FROM bots
      WHERE
        user_id = ?
        AND (
          is_default < ?
          OR (is_default = ? AND created_at < ?)
          OR (is_default = ? AND created_at = ? AND id < ?)
        )
      LIMIT 1
    `)
    .get(
      userId,
      last.is_default,
      last.is_default,
      last.created_at,
      last.is_default,
      last.created_at,
      last.id,
    ) as { 1: number } | undefined

  return {
    bots,
    hasOlder: Boolean(hasOlder),
    hasNewer: Boolean(hasNewer),
  }
}
