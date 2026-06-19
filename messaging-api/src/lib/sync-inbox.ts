import type Database from 'better-sqlite3'
import {
  accountSyncMarkerExists,
  listAccountEventRowsAfterMarker,
  listConversationActivitySinceMarker,
  resolveAccountFeedTip,
} from '../db/repos/chat-sync-events.js'

export interface SyncInboxChange {
  conversation_id: string
  kind: 'deleted' | 'updated'
}

export interface SyncInboxResult {
  changes: SyncInboxChange[]
  next_cursor: string
  has_more: boolean
  reset_required: boolean
}

export interface BuildInboxOptions {
  maxGap: number
}

export function buildInbox(
  db: Database.Database,
  userId: string,
  since: string | null | undefined,
  options: BuildInboxOptions,
): SyncInboxResult {
  const tip = resolveAccountFeedTip(db, userId)

  if (since === null || since === undefined) {
    return { changes: [], next_cursor: tip, has_more: false, reset_required: true }
  }

  if (!accountSyncMarkerExists(db, userId, since)) {
    return { changes: [], next_cursor: tip, has_more: false, reset_required: true }
  }

  const accountRows = listAccountEventRowsAfterMarker(db, userId, since, options.maxGap + 1)
  if (accountRows.length > options.maxGap) {
    return { changes: [], next_cursor: tip, has_more: false, reset_required: true }
  }

  const deleted = new Set<string>()
  const updatedLatest = new Map<string, string>()

  for (const row of accountRows) {
    if (row.event_type === 'conversation_deleted') {
      deleted.add(row.conversation_id)
      updatedLatest.delete(row.conversation_id)
      continue
    }

    if (row.event_type === 'conversation_upsert' && !deleted.has(row.conversation_id)) {
      const prev = updatedLatest.get(row.conversation_id)
      if (!prev || row.occurred_at > prev) {
        updatedLatest.set(row.conversation_id, row.occurred_at)
      }
    }
  }

  for (const activity of listConversationActivitySinceMarker(db, userId, since)) {
    if (deleted.has(activity.conversation_id)) {
      continue
    }

    const prev = updatedLatest.get(activity.conversation_id)
    if (!prev || activity.latest_occurred_at > prev) {
      updatedLatest.set(activity.conversation_id, activity.latest_occurred_at)
    }
  }

  const changes: SyncInboxChange[] = [
    ...[...deleted].map((conversation_id) => ({ conversation_id, kind: 'deleted' as const })),
    ...[...updatedLatest.entries()]
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .map(([conversation_id]) => ({ conversation_id, kind: 'updated' as const })),
  ]

  return { changes, next_cursor: tip, has_more: false, reset_required: false }
}

const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidDeviceId(value: string | undefined): boolean {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value)
}