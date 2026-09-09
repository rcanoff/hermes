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
  readSoulFile,
} from '../../lib/hermes-profile.js'
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

const BOT_COLUMNS = `id, slug, name, role, soul, responsibilities, icon, color, runtime, is_default, created_at`

export interface BotRow {
  id: string
  slug: string
  name: string
  role: string
  soul: string
  responsibilities: string
  icon: string
  color: string
  runtime: BotRuntime
  is_default: number
  created_at: string
}

export interface BotPage {
  bots: BotRow[]
  hasOlder: boolean
  hasNewer: boolean
}

export interface CreateBotInput {
  slug: string
  name: string
  role: string
  soul: string
  responsibilities?: string
  icon?: BotIcon
  color?: BotColor
  runtime?: BotRuntime
  isDefault?: boolean
}

export function isBotRuntime(value: unknown): value is BotRuntime {
  return value === 'hermes' || value === 'grok'
}

export function normalizeBotRuntime(value: string): BotRuntime {
  return value === 'grok' ? 'grok' : 'hermes'
}

export function ensureDefaultBotRow(db: Database.Database, soul = DEFAULT_BOT_SOUL): BotRow {
  const existing = getBotBySlug(db, DEFAULT_BOT_SLUG)
  if (existing) {
    return existing
  }

  return insertBot(db, {
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

export function seedDefaultBot(db: Database.Database, hermesHome: string): BotRow {
  const existing = getBotBySlug(db, DEFAULT_BOT_SLUG)
  if (existing) {
    seedKnownBotResponsibilities(db)
    return getBotBySlug(db, DEFAULT_BOT_SLUG)!
  }

  const soul = readSoulFile(hermesHome, DEFAULT_BOT_SLUG) ?? DEFAULT_BOT_SOUL
  return ensureDefaultBotRow(db, soul)
}

export function insertBot(db: Database.Database, input: CreateBotInput): BotRow {
  const id = randomUUID()
  const runtime = input.runtime ?? DEFAULT_BOT_RUNTIME
  db.prepare(`
    INSERT INTO bots (id, slug, name, role, soul, responsibilities, icon, color, runtime, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.slug,
    input.name,
    input.role,
    input.soul,
    input.responsibilities ?? '',
    input.icon ?? DEFAULT_BOT_ICON,
    input.color ?? DEFAULT_BOT_COLOR,
    runtime,
    input.isDefault ? 1 : 0,
  )

  return getBotById(db, id)!
}

export function getBotById(db: Database.Database, id: string): BotRow | undefined {
  return db
    .prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`)
    .get(id) as BotRow | undefined
}

export function getBotsByIds(db: Database.Database, ids: string[]): Map<string, BotRow> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))]
  const result = new Map<string, BotRow>()
  if (unique.length === 0) {
    return result
  }

  const placeholders = unique.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE id IN (${placeholders})`)
    .all(...unique) as BotRow[]

  for (const row of rows) {
    result.set(row.id, row)
  }

  return result
}

export function getBotBySlug(db: Database.Database, slug: string): BotRow | undefined {
  return db
    .prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE slug = ?`)
    .get(slug) as BotRow | undefined
}

export function getGrokBot(db: Database.Database): BotRow | undefined {
  return db
    .prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE runtime = 'grok' LIMIT 1`)
    .get() as BotRow | undefined
}

export function listBotsForRoster(db: Database.Database): BotRow[] {
  return db
    .prepare(`
      SELECT ${BOT_COLUMNS}
      FROM bots
      ORDER BY is_default DESC, name ASC, id ASC
    `)
    .all() as BotRow[]
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

export function deleteBot(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM bots WHERE id = ?`).run(id)
  return result.changes === 1
}

export function listBotsPage(
  db: Database.Database,
  limit: number,
  anchors: ListPageAnchors = {},
): BotPage | null {
  if (anchors.before) {
    const cursor = getBotById(db, anchors.before)
    if (!cursor) {
      return null
    }

    const bots = db
      .prepare(`
        SELECT ${BOT_COLUMNS}
        FROM bots
        WHERE
          is_default < ?
          OR (is_default = ? AND created_at < ?)
          OR (is_default = ? AND created_at = ? AND id < ?)
        ORDER BY is_default DESC, created_at DESC, id DESC
        LIMIT ?
      `)
      .all(
        cursor.is_default,
        cursor.is_default,
        cursor.created_at,
        cursor.is_default,
        cursor.created_at,
        cursor.id,
        limit,
      ) as BotRow[]

    return buildBotPage(db, bots)
  }

  if (anchors.after) {
    const cursor = getBotById(db, anchors.after)
    if (!cursor) {
      return null
    }

    const bots = db
      .prepare(`
        SELECT ${BOT_COLUMNS}
        FROM bots
        WHERE
          is_default > ?
          OR (is_default = ? AND created_at > ?)
          OR (is_default = ? AND created_at = ? AND id > ?)
        ORDER BY is_default ASC, created_at ASC, id ASC
        LIMIT ?
      `)
      .all(
        cursor.is_default,
        cursor.is_default,
        cursor.created_at,
        cursor.is_default,
        cursor.created_at,
        cursor.id,
        limit,
      ) as BotRow[]

    bots.reverse()
    return buildBotPage(db, bots)
  }

  const bots = db
    .prepare(`
      SELECT ${BOT_COLUMNS}
      FROM bots
      ORDER BY is_default DESC, created_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit) as BotRow[]

  return buildBotPage(db, bots)
}

export function soulForResponse(row: BotRow, hermesHome: string): string {
  if (normalizeBotRuntime(row.runtime) === 'grok') {
    return row.soul
  }
  return readSoulFile(hermesHome, row.slug) ?? row.soul
}

function buildBotPage(db: Database.Database, bots: BotRow[]): BotPage {
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
        is_default > ?
        OR (is_default = ? AND created_at > ?)
        OR (is_default = ? AND created_at = ? AND id > ?)
      LIMIT 1
    `)
    .get(
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
        is_default < ?
        OR (is_default = ? AND created_at < ?)
        OR (is_default = ? AND created_at = ? AND id < ?)
      LIMIT 1
    `)
    .get(
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
