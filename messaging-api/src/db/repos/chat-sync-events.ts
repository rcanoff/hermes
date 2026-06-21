import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { buildConversationSyncEntry } from '../../lib/conversation-sync-entry.js'
import { isSyncMarkerOrigin, SYNC_MARKER_ORIGIN } from '../../lib/sync-marker.js'
import { getConversationForUser, type ConversationRow } from './conversations.js'
import type { MessageWithAttachments } from '../../lib/attachment-serializer.js'
import type { MessageRow } from './messages.js'

export interface ConversationSyncEntryPayload {
  id: string
  hermes_session_id: string
  kind: 'regular' | 'job'
  title: string | null
  created_at: string
  updated_at: string
  latest_message_id: string | null
  latest_message_created_at: string | null
  hermes_job_id?: string | null
  schedule_display?: string | null
  job_enabled?: boolean
  job_last_run_at?: string | null
  job_last_status?: string | null
}

export type AccountSyncEvent =
  | {
      event_id: string
      type: 'conversation_upsert'
      occurred_at: string
      conversation: ConversationSyncEntryPayload
    }
  | {
      event_id: string
      type: 'conversation_deleted'
      occurred_at: string
      conversation_id: string
    }

export type ConversationSyncEvent =
  | {
      event_id: string
      type: 'message_upsert'
      occurred_at: string
      message: MessageWithAttachments
    }
  | {
      event_id: string
      type: 'message_deleted'
      occurred_at: string
      message_id: string
    }
  | {
      event_id: string
      type: 'messages_rewound'
      occurred_at: string
      removed_message_ids: string[]
    }
  | {
      event_id: string
      type: 'conversation_deleted'
      occurred_at: string
      conversation_id: string
    }

export interface SyncEventPage<T> {
  events: T[]
  next_sync_marker: string
  has_more: boolean
}

interface StoredEventRow {
  id: string
  scope: 'account' | 'conversation'
  user_id: string
  conversation_id: string
  event_type: string
  occurred_at: string
  payload_json: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function insertEvent(
  db: Database.Database,
  input: {
    scope: 'account' | 'conversation'
    userId: string
    conversationId: string
    eventType: string
    payload: unknown
  },
): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO chat_sync_events (id, scope, user_id, conversation_id, event_type, occurred_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.scope,
    input.userId,
    input.conversationId,
    input.eventType,
    nowIso(),
    JSON.stringify(input.payload),
  )
  return id
}

export function appendAccountConversationUpsert(
  db: Database.Database,
  userId: string,
  conversationId: string,
  conversation: ConversationSyncEntryPayload,
): { event_id: string } {
  const event_id = insertEvent(db, {
    scope: 'account',
    userId,
    conversationId,
    eventType: 'conversation_upsert',
    payload: { conversation },
  })
  return { event_id }
}

export function appendAccountConversationDeleted(
  db: Database.Database,
  userId: string,
  conversationId: string,
): { event_id: string } {
  const event_id = insertEvent(db, {
    scope: 'account',
    userId,
    conversationId,
    eventType: 'conversation_deleted',
    payload: { conversation_id: conversationId },
  })
  return { event_id }
}

export function appendConversationMessageUpsert(
  db: Database.Database,
  userId: string,
  conversationId: string,
  message: MessageWithAttachments,
): { event_id: string } {
  const event_id = insertEvent(db, {
    scope: 'conversation',
    userId,
    conversationId,
    eventType: 'message_upsert',
    payload: { message },
  })
  return { event_id }
}

export function appendConversationMessageDeleted(
  db: Database.Database,
  userId: string,
  conversationId: string,
  messageId: string,
): { event_id: string } {
  const event_id = insertEvent(db, {
    scope: 'conversation',
    userId,
    conversationId,
    eventType: 'message_deleted',
    payload: { message_id: messageId },
  })
  return { event_id }
}

export function appendConversationMessagesRewound(
  db: Database.Database,
  userId: string,
  conversationId: string,
  removedMessageIds: string[],
): { event_id: string } {
  const event_id = insertEvent(db, {
    scope: 'conversation',
    userId,
    conversationId,
    eventType: 'messages_rewound',
    payload: { removed_message_ids: removedMessageIds },
  })
  return { event_id }
}

export function appendConversationConversationDeleted(
  db: Database.Database,
  userId: string,
  conversationId: string,
): { event_id: string } {
  const event_id = insertEvent(db, {
    scope: 'conversation',
    userId,
    conversationId,
    eventType: 'conversation_deleted',
    payload: { conversation_id: conversationId },
  })
  return { event_id }
}

function getStoredEvent(
  db: Database.Database,
  eventId: string,
  scope: 'account' | 'conversation',
  userId: string,
  conversationId?: string,
): StoredEventRow | undefined {
  if (conversationId) {
    return db
      .prepare(`
        SELECT id, scope, user_id, conversation_id, event_type, occurred_at, payload_json
        FROM chat_sync_events
        WHERE id = ? AND scope = ? AND user_id = ? AND conversation_id = ?
      `)
      .get(eventId, scope, userId, conversationId) as StoredEventRow | undefined
  }

  return db
    .prepare(`
      SELECT id, scope, user_id, conversation_id, event_type, occurred_at, payload_json
      FROM chat_sync_events
      WHERE id = ? AND scope = ? AND user_id = ?
    `)
    .get(eventId, scope, userId) as StoredEventRow | undefined
}

export interface AccountEventRow {
  id: string
  conversation_id: string
  event_type: string
  occurred_at: string
}

export function resolveAccountFeedTip(db: Database.Database, userId: string): string {
  const row = db
    .prepare(`
      SELECT id
      FROM chat_sync_events
      WHERE scope = 'account' AND user_id = ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `)
    .get(userId) as { id: string } | undefined

  return row?.id ?? SYNC_MARKER_ORIGIN
}

function resolveConversationFeedTip(db: Database.Database, conversationId: string): string {
  const row = db
    .prepare(`
      SELECT id
      FROM chat_sync_events
      WHERE scope = 'conversation' AND conversation_id = ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `)
    .get(conversationId) as { id: string } | undefined

  return row?.id ?? SYNC_MARKER_ORIGIN
}

function validateSinceMarker(
  db: Database.Database,
  since: string | undefined,
  scope: 'account' | 'conversation',
  userId: string,
  conversationId?: string,
): boolean {
  if (isSyncMarkerOrigin(since)) {
    return true
  }

  return getStoredEvent(db, since!, scope, userId, conversationId) !== undefined
}

export function accountSyncMarkerExists(
  db: Database.Database,
  userId: string,
  marker: string | null | undefined,
): boolean {
  if (marker === null || marker === undefined) {
    return false
  }

  return validateSinceMarker(db, marker, 'account', userId)
}

export function listAccountEventRowsAfterMarker(
  db: Database.Database,
  userId: string,
  since: string | undefined,
  limit: number,
): AccountEventRow[] {
  return fetchScopedRows(db, 'account', userId, undefined, since, limit).map((row) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
  }))
}

export function listConversationActivitySinceMarker(
  db: Database.Database,
  userId: string,
  since: string | undefined,
): Array<{ conversation_id: string; latest_occurred_at: string }> {
  if (isSyncMarkerOrigin(since)) {
    return db
      .prepare(`
        SELECT conversation_id, MAX(occurred_at) AS latest_occurred_at
        FROM chat_sync_events
        WHERE scope = 'conversation' AND user_id = ?
        GROUP BY conversation_id
      `)
      .all(userId) as Array<{ conversation_id: string; latest_occurred_at: string }>
  }

  const cursor = db
    .prepare(`
      SELECT id, occurred_at
      FROM chat_sync_events
      WHERE id = ? AND scope = 'account' AND user_id = ?
    `)
    .get(since!, userId) as { id: string; occurred_at: string } | undefined

  if (!cursor) {
    return []
  }

  return db
    .prepare(`
      SELECT conversation_id, MAX(occurred_at) AS latest_occurred_at
      FROM chat_sync_events
      WHERE scope = 'conversation'
        AND user_id = ?
        AND (
          occurred_at > ?
          OR (occurred_at = ? AND id > ?)
        )
      GROUP BY conversation_id
    `)
    .all(userId, cursor.occurred_at, cursor.occurred_at, cursor.id) as Array<{
      conversation_id: string
      latest_occurred_at: string
    }>
}

function fetchScopedRows(
  db: Database.Database,
  scope: 'account' | 'conversation',
  userId: string,
  conversationId: string | undefined,
  since: string | undefined,
  limit: number,
): StoredEventRow[] {
  if (isSyncMarkerOrigin(since)) {
    if (scope === 'account') {
      return db
        .prepare(`
          SELECT id, scope, user_id, conversation_id, event_type, occurred_at, payload_json
          FROM chat_sync_events
          WHERE scope = 'account' AND user_id = ?
          ORDER BY occurred_at ASC, id ASC
          LIMIT ?
        `)
        .all(userId, limit) as StoredEventRow[]
    }

    return db
      .prepare(`
        SELECT id, scope, user_id, conversation_id, event_type, occurred_at, payload_json
        FROM chat_sync_events
        WHERE scope = 'conversation' AND conversation_id = ?
        ORDER BY occurred_at ASC, id ASC
        LIMIT ?
      `)
      .all(conversationId!, limit) as StoredEventRow[]
  }

  const cursor = getStoredEvent(db, since!, scope, userId, conversationId)!
  if (scope === 'account') {
    return db
      .prepare(`
        SELECT id, scope, user_id, conversation_id, event_type, occurred_at, payload_json
        FROM chat_sync_events
        WHERE scope = 'account'
          AND user_id = ?
          AND (
            occurred_at > ?
            OR (occurred_at = ? AND id > ?)
          )
        ORDER BY occurred_at ASC, id ASC
        LIMIT ?
      `)
      .all(userId, cursor.occurred_at, cursor.occurred_at, cursor.id, limit) as StoredEventRow[]
  }

  return db
    .prepare(`
      SELECT id, scope, user_id, conversation_id, event_type, occurred_at, payload_json
      FROM chat_sync_events
      WHERE scope = 'conversation'
        AND conversation_id = ?
        AND (
          occurred_at > ?
          OR (occurred_at = ? AND id > ?)
        )
      ORDER BY occurred_at ASC, id ASC
      LIMIT ?
    `)
    .all(conversationId!, cursor.occurred_at, cursor.occurred_at, cursor.id, limit) as StoredEventRow[]
}

function buildSyncPage<T>(
  rows: StoredEventRow[],
  limit: number,
  tipResolver: () => string,
  mapRow: (row: StoredEventRow) => T,
): SyncEventPage<T> {
  const has_more = rows.length > limit
  const pageRows = has_more ? rows.slice(0, limit) : rows
  const events = pageRows.map(mapRow)

  return {
    events,
    next_sync_marker:
      pageRows.length > 0 ? pageRows[pageRows.length - 1]!.id : tipResolver(),
    has_more,
  }
}

function mapAccountEvent(row: StoredEventRow): AccountSyncEvent {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>

  if (row.event_type === 'conversation_upsert') {
    return {
      event_id: row.id,
      type: 'conversation_upsert',
      occurred_at: row.occurred_at,
      conversation: payload.conversation as ConversationSyncEntryPayload,
    }
  }

  return {
    event_id: row.id,
    type: 'conversation_deleted',
    occurred_at: row.occurred_at,
    conversation_id: payload.conversation_id as string,
  }
}

function mapConversationEvent(row: StoredEventRow): ConversationSyncEvent {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>

  switch (row.event_type) {
    case 'message_upsert':
      return {
        event_id: row.id,
        type: 'message_upsert',
        occurred_at: row.occurred_at,
        message: payload.message as MessageWithAttachments,
      }
    case 'message_deleted':
      return {
        event_id: row.id,
        type: 'message_deleted',
        occurred_at: row.occurred_at,
        message_id: payload.message_id as string,
      }
    case 'messages_rewound':
      return {
        event_id: row.id,
        type: 'messages_rewound',
        occurred_at: row.occurred_at,
        removed_message_ids: payload.removed_message_ids as string[],
      }
    default:
      return {
        event_id: row.id,
        type: 'conversation_deleted',
        occurred_at: row.occurred_at,
        conversation_id: payload.conversation_id as string,
      }
  }
}

export function listAccountSyncEvents(
  db: Database.Database,
  userId: string,
  since: string | undefined,
  limit: number,
): SyncEventPage<AccountSyncEvent> | null {
  if (!validateSinceMarker(db, since, 'account', userId)) {
    return null
  }

  const rows = fetchScopedRows(db, 'account', userId, undefined, since, limit + 1)
  return buildSyncPage(rows, limit, () => resolveAccountFeedTip(db, userId), mapAccountEvent)
}

export function listConversationSyncEvents(
  db: Database.Database,
  userId: string,
  conversationId: string,
  since: string | undefined,
  limit: number,
): SyncEventPage<ConversationSyncEvent> | null {
  if (!validateSinceMarker(db, since, 'conversation', userId, conversationId)) {
    return null
  }

  const rows = fetchScopedRows(db, 'conversation', userId, conversationId, since, limit + 1)
  return buildSyncPage(rows, limit, () => resolveConversationFeedTip(db, conversationId), mapConversationEvent)
}

export function listConversationDeletionSync(
  db: Database.Database,
  userId: string,
  conversationId: string,
  since: string | undefined,
  limit: number,
): SyncEventPage<ConversationSyncEvent> | null {
  if (!validateSinceMarker(db, since, 'conversation', userId, conversationId)) {
    return null
  }

  const rows = fetchScopedRows(db, 'conversation', userId, conversationId, since, limit + 1).filter(
    (row) => row.event_type === 'conversation_deleted',
  )

  return buildSyncPage(rows, limit, () => resolveConversationFeedTip(db, conversationId), mapConversationEvent)
}

export function backfillAccountSyncEvents(db: Database.Database): void {
  const done = db.prepare(`SELECT 1 FROM chat_sync_events LIMIT 1`).get() as { 1: number } | undefined
  if (done) {
    return
  }

  const conversations = db
    .prepare(`SELECT id, user_id FROM conversations`)
    .all() as Array<{ id: string; user_id: string }>

  for (const row of conversations) {
    const conversation = getConversationForUser(db, row.user_id, row.id)

    if (!conversation) {
      continue
    }

    appendAccountConversationUpsert(
      db,
      row.user_id,
      row.id,
      buildConversationSyncEntry(db, conversation),
    )
  }
}

export function conversationHasSyncTail(db: Database.Database, conversationId: string): boolean {
  const row = db
    .prepare(`
      SELECT 1
      FROM chat_sync_events
      WHERE scope = 'conversation' AND conversation_id = ?
      LIMIT 1
    `)
    .get(conversationId) as { 1: number } | undefined

  return row !== undefined
}

export function getConversationForSyncTail(
  db: Database.Database,
  userId: string,
  conversationId: string,
): ConversationRow | undefined {
  return getConversationForUser(db, userId, conversationId)
}