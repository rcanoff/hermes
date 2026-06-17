import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../src/db/schema.js'
import {
  appendAccountConversationDeleted,
  appendAccountConversationUpsert,
  listAccountSyncEvents,
} from '../src/db/repos/chat-sync-events.js'
import { SYNC_MARKER_ORIGIN } from '../src/lib/sync-marker.js'

describe('chat-sync-events repo', () => {
  it('lists account events after marker in stable order', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = '00000000-0000-4000-8000-000000000101'
    const conversationId = '00000000-0000-4000-8000-000000000201'
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)
    db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(conversationId, userId, '00000000-0000-4000-8000-000000000301')

    const first = appendAccountConversationUpsert(db, userId, conversationId, {
      id: conversationId,
      hermes_session_id: '00000000-0000-4000-8000-000000000301',
      title: null,
      created_at: '2026-06-17 10:00:00',
      updated_at: '2026-06-17 10:00:00',
      latest_message_id: null,
      latest_message_created_at: null,
    })
    const second = appendAccountConversationDeleted(db, userId, conversationId)

    const page = listAccountSyncEvents(db, userId, undefined, 100)
    expect(page?.events).toHaveLength(2)
    expect(page?.events[0]!.event_id).toBe(first.event_id)
    expect(page?.events[1]!.event_id).toBe(second.event_id)
    expect(page?.next_sync_marker).toBe(second.event_id)
    expect(page?.has_more).toBe(false)

    const tail = listAccountSyncEvents(db, userId, first.event_id, 100)
    expect(tail?.events).toHaveLength(1)
    expect(tail?.events[0]!.type).toBe('conversation_deleted')
  })

  it('returns origin tip marker for empty account feed', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = '00000000-0000-4000-8000-000000000101'
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)

    const page = listAccountSyncEvents(db, userId, undefined, 100)
    expect(page).toEqual({
      events: [],
      next_sync_marker: SYNC_MARKER_ORIGIN,
      has_more: false,
    })
  })

  it('rejects unknown account markers', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = '00000000-0000-4000-8000-000000000101'
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)

    expect(listAccountSyncEvents(db, userId, '00000000-0000-4000-8000-000000000999', 100)).toBeNull()
  })
})