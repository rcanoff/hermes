import { describe, expect, it } from 'vitest'
import { getConversationForUser } from '../src/db/repos/conversations.js'
import { insertMessage, listMessages } from '../src/db/repos/messages.js'
import { createRun } from '../src/db/repos/runs.js'
import {
  MessageRewindError,
  removeConversationMessagesFrom,
} from '../src/services/conversation-message-rewind.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('removeConversationMessagesFrom', () => {
  it('removes the anchor message and all later messages, then rotates hermes_session_id', async () => {
    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-old', 'regular', datetime('now'))
    `).run(seeded.id)

    const firstUser = insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'user',
      content: 'Mitte search',
    })
    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'assistant',
      content: 'Mitte results',
    })
    const cronUser = insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'user',
      content: 'make this a cron',
    })
    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'assistant',
      content: 'Friedrichshain job created',
    })

    app.db
      .prepare(`UPDATE conversations SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`)
      .run('regular-1')

    const removed = removeConversationMessagesFrom(
      app.db,
      seeded.id,
      'regular-1',
      cronUser,
    )

    expect(removed.removedMessageIds).toHaveLength(2)
    expect(listMessages(app.db, 'regular-1').map((message) => message.id)).toEqual([
      firstUser,
      expect.any(String),
    ])

    const conversation = getConversationForUser(app.db, seeded.id, 'regular-1')
    expect(conversation?.hermes_session_id).toBe(removed.hermesSessionId)
    expect(conversation?.hermes_session_id).not.toBe('sess-old')
    expect(conversation?.updated_at).not.toBe('2020-01-01 00:00:00')

    await app.close()
  })

  it('rejects rewind while a run references a message being removed', async () => {
    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-old', 'regular', datetime('now'))
    `).run(seeded.id)

    const userMessageId = insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'user',
      content: 'pending',
    })
    createRun(app.db, 'regular-1', userMessageId, 'origin-1')

    expect(() =>
      removeConversationMessagesFrom(app.db, seeded.id, 'regular-1', userMessageId),
    ).toThrow(MessageRewindError)

    await app.close()
  })

  it('supports sequential tail deletes on the same conversation', async () => {
    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-old', 'regular', datetime('now'))
    `).run(seeded.id)

    const userId = insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'user',
      content: 'hello',
    })
    const assistantId = insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'assistant',
      content: 'hi',
    })

    const first = removeConversationMessagesFrom(
      app.db,
      seeded.id,
      'regular-1',
      assistantId,
    )
    expect(first.removedMessageIds).toEqual([assistantId])

    const second = removeConversationMessagesFrom(
      app.db,
      seeded.id,
      'regular-1',
      userId,
    )
    expect(second.removedMessageIds).toEqual([userId])
    expect(listMessages(app.db, 'regular-1')).toHaveLength(0)

    await app.close()
  })
})