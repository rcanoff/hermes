import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../src/db/schema.js'
import {
  appendAccountConversationDeleted,
  appendAccountConversationUpsert,
  appendConversationMessageUpsert,
} from '../src/db/repos/chat-sync-events.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { buildInbox } from '../src/lib/sync-inbox.js'
import { SYNC_MARKER_ORIGIN } from '../src/lib/sync-marker.js'
import { removeConversationMessagesFrom } from '../src/services/conversation-message-rewind.js'

function seedUser(db: Database.Database, userId: string) {
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)
}

function seedConversation(db: Database.Database, userId: string, conversationId: string) {
  db.prepare(`
    INSERT INTO conversations (id, user_id, hermes_session_id, title, created_at, updated_at)
    VALUES (?, ?, ?, 't', datetime('now'), datetime('now'))
  `).run(conversationId, userId, randomUUID())
}

function conversationPayload(conversationId: string) {
  return {
    id: conversationId,
    hermes_session_id: randomUUID(),
    kind: 'regular' as const,
    title: 't',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    latest_message_id: null,
    latest_message_created_at: null,
  }
}

describe('buildInbox', () => {
  it('returns reset_required when since cursor is null', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    seedUser(db, userId)

    const result = buildInbox(db, userId, null, { maxGap: 500 })

    expect(result).toEqual({
      changes: [],
      next_cursor: SYNC_MARKER_ORIGIN,
      has_more: false,
      reset_required: true,
    })
  })

  it('coalesces delete over update for same conversation', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const conversationId = randomUUID()
    seedUser(db, userId)
    seedConversation(db, userId, conversationId)

    const upsert = appendAccountConversationUpsert(
      db,
      userId,
      conversationId,
      conversationPayload(conversationId),
    )
    appendAccountConversationDeleted(db, userId, conversationId)

    const result = buildInbox(db, userId, upsert.event_id, { maxGap: 500 })

    expect(result.reset_required).toBe(false)
    expect(result.changes).toEqual([{ conversation_id: conversationId, kind: 'deleted' }])
  })

  it('returns updated when only conversation-scoped message events exist', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const conversationId = randomUUID()
    seedUser(db, userId)
    seedConversation(db, userId, conversationId)

    const upsert = appendAccountConversationUpsert(
      db,
      userId,
      conversationId,
      conversationPayload(conversationId),
    )

    for (let i = 0; i < 10; i += 1) {
      appendConversationMessageUpsert(db, userId, conversationId, {
        id: randomUUID(),
        conversation_id: conversationId,
        role: 'assistant',
        content: `m${i}`,
        created_at: `2026-01-01T00:00:0${i}.000Z`,
      })
    }

    const result = buildInbox(db, userId, upsert.event_id, { maxGap: 500 })

    expect(result.reset_required).toBe(false)
    expect(result.changes).toEqual([{ conversation_id: conversationId, kind: 'updated' }])
  })

  it('returns updated after messages are rewound', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const conversationId = randomUUID()
    seedUser(db, userId)
    seedConversation(db, userId, conversationId)

    const upsert = appendAccountConversationUpsert(
      db,
      userId,
      conversationId,
      conversationPayload(conversationId),
    )

    insertMessage(db, {
      conversationId,
      role: 'user',
      content: 'hello',
    })
    const assistantId = insertMessage(db, {
      conversationId,
      role: 'assistant',
      content: 'reply',
    })

    removeConversationMessagesFrom(db, userId, conversationId, assistantId)

    const result = buildInbox(db, userId, upsert.event_id, { maxGap: 500 })

    expect(result.reset_required).toBe(false)
    expect(result.changes).toEqual([{ conversation_id: conversationId, kind: 'updated' }])
  })

  it('returns reset_required when account gap exceeds maxGap', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    seedUser(db, userId)

    for (let i = 0; i < 3; i += 1) {
      const conversationId = randomUUID()
      seedConversation(db, userId, conversationId)
      appendAccountConversationUpsert(
        db,
        userId,
        conversationId,
        {
          ...conversationPayload(conversationId),
          title: `c${i}`,
          created_at: `2026-01-01T00:00:0${i}.000Z`,
          updated_at: `2026-01-01T00:00:0${i}.000Z`,
        },
      )
    }

    const result = buildInbox(db, userId, SYNC_MARKER_ORIGIN, { maxGap: 2 })

    expect(result.reset_required).toBe(true)
    expect(result.changes).toEqual([])
  })
})