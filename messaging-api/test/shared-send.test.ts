import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { seedTestUser } from './helpers/users.js'

describe('shared send', () => {
  let app: FastifyInstance | undefined
  let hermes: FakeHermesClient

  beforeEach(async () => {
    hermes = new FakeHermesClient()
    app = await createTestApp({ hermesClient: hermes })
    await app.ready()
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('fans a DM out to the other member and does not start a run', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const dm = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { kind: 'user_dm', participant_user_ids: [bob.id] },
    })
    const clientMessageId = randomUUID()

    const sent = await app!.inject({
      method: 'POST',
      url: `/conversations/${dm.json().id}/messages`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { text: 'hey bob', client_message_id: clientMessageId },
    })

    expect(sent.statusCode).toBe(202)
    expect(sent.json().message).toMatchObject({
      content: 'hey bob',
      sequence: 1,
      mentioned_bot_id: null,
      sender_user: { id: alice.id, username: 'alice' },
    })
    expect(sent.json().message).not.toHaveProperty('sender_user_id')

    const feed = await app!.inject({
      method: 'GET',
      url: '/conversations/sync?include_shared=true',
      headers: { authorization: `Bearer ${bob.token}` },
    })
    const messageEvent = feed.json().events.find(
      (event: { type: string; message?: { content?: string } }) =>
        event.type === 'message_upsert' && event.message?.content === 'hey bob',
    )
    expect(messageEvent).toBeTruthy()
    expect(accountEventCount(app!, bob.id, dm.json().id, 'message_upsert')).toBe(1)
    expect(accountEventCount(app!, alice.id, dm.json().id, 'message_upsert')).toBe(1)
    expect(conversationEventCount(app!, dm.json().id, 'message_upsert')).toBe(1)
    expect(runCount(app!, dm.json().id)).toBe(0)
    expect(hermes.ensureSessionRequests).toEqual([])
  })

  it('stores an untagged group message without a run or queue row', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: {
        kind: 'group',
        participant_user_ids: [bob.id],
        bot_ids: [defaultBotId(app!, alice.id)],
      },
    })

    const sent = await app!.inject({
      method: 'POST',
      url: `/conversations/${group.json().id}/messages`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { text: 'just chatting', client_message_id: randomUUID() },
    })

    expect(sent.statusCode).toBe(202)
    expect(sent.json().message.mentioned_bot_id).toBeNull()
    expect(runCount(app!, group.json().id)).toBe(0)
    expect(groupRunCount(app!, group.json().id)).toBe(0)
  })
  it('enqueues one run per mentioned group bot', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const extra = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { name: 'Guide', role: 'helper' },
    })
    const defaultId = defaultBotId(app!, alice.id)
    const group = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: {
        kind: 'group',
        participant_user_ids: [bob.id],
        bot_ids: [defaultId, extra.json().id],
      },
    })

    const sent = await app!.inject({
      method: 'POST',
      url: `/conversations/${group.json().id}/messages`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: {
        text: 'compare these',
        client_message_id: randomUUID(),
        mentioned_bot_ids: [extra.json().id, defaultId, extra.json().id],
      },
    })

    expect(sent.statusCode).toBe(202)
    expect(
      app!.db
        .prepare(`SELECT bot_id FROM group_bot_runs WHERE message_id = ? ORDER BY bot_id`)
        .all(sent.json().message.id),
    ).toEqual(
      [{ bot_id: defaultId }, { bot_id: extra.json().id }].sort((a, b) => a.bot_id.localeCompare(b.bot_id)),
    )
  })
  it('returns a group replay before validating mention fields', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const botId = defaultBotId(app!, alice.id)
    const group = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { kind: 'group', participant_user_ids: [bob.id], bot_ids: [botId] },
    })
    const headers = { authorization: `Bearer ${alice.token}` }
    const clientMessageId = randomUUID()
    const first = await app!.inject({
      method: 'POST',
      url: `/conversations/${group.json().id}/messages`,
      headers,
      payload: { text: 'once', client_message_id: clientMessageId, mentioned_bot_ids: [botId] },
    })
    const second = await app!.inject({
      method: 'POST',
      url: `/conversations/${group.json().id}/messages`,
      headers,
      payload: { text: 'once', client_message_id: clientMessageId, mentioned_bot_ids: ['not-a-uuid'] },
    })

    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(200)
    expect(second.json().message.id).toBe(first.json().message.id)
  })


  it('returns the original message for a replayed client id', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const dm = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { kind: 'user_dm', participant_user_ids: [bob.id] },
    })
    const clientMessageId = randomUUID()
    const payload = { text: 'once', client_message_id: clientMessageId }
    const headers = { authorization: `Bearer ${alice.token}` }

    const first = await app!.inject({
      method: 'POST',
      url: `/conversations/${dm.json().id}/messages`,
      headers,
      payload,
    })
    const second = await app!.inject({
      method: 'POST',
      url: `/conversations/${dm.json().id}/messages`,
      headers,
      payload,
    })

    expect(second.statusCode).toBe(200)
    expect(second.json().message.id).toBe(first.json().message.id)
    expect(messageCount(app!, dm.json().id)).toBe(1)
    expect(accountEventCount(app!, bob.id, dm.json().id, 'message_upsert')).toBe(1)
    expect(runCount(app!, dm.json().id)).toBe(0)
  })

  it('stores nothing for a mention that is not the room bot', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: {
        kind: 'group',
        participant_user_ids: [bob.id],
        bot_ids: [defaultBotId(app!, alice.id)],
      },
    })
    const before = messageCount(app!, group.json().id)

    const sent = await app!.inject({
      method: 'POST',
      url: `/conversations/${group.json().id}/messages`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: {
        text: '@nope',
        client_message_id: randomUUID(),
        mentioned_bot_ids: [randomUUID()],
      },
    })

    expect(sent.statusCode).toBe(400)
    expect(messageCount(app!, group.json().id)).toBe(before)
    expect(groupRunCount(app!, group.json().id)).toBe(0)
  })

  it('rejects a non-member send', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const carol = await seedTestUser(app!, 'carol', 'password123')
    const dm = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { kind: 'user_dm', participant_user_ids: [bob.id] },
    })

    const sent = await app!.inject({
      method: 'POST',
      url: `/conversations/${dm.json().id}/messages`,
      headers: { authorization: `Bearer ${carol.token}` },
      payload: { text: 'nope', client_message_id: randomUUID() },
    })

    expect(sent.statusCode).toBe(404)
    expect(messageCount(app!, dm.json().id)).toBe(0)
  })
})

function messageCount(app: FastifyInstance, conversationId: string): number {
  return (
    app.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`).get(conversationId) as {
      n: number
    }
  ).n
}

function runCount(app: FastifyInstance, conversationId: string): number {
  return (
    app.db.prepare(`SELECT COUNT(*) AS n FROM message_runs WHERE conversation_id = ?`).get(conversationId) as {
      n: number
    }
  ).n
}

function groupRunCount(app: FastifyInstance, conversationId: string): number {
  return (
    app.db
      .prepare(`SELECT COUNT(*) AS n FROM group_bot_runs WHERE conversation_id = ?`)
      .get(conversationId) as { n: number }
  ).n
}

function accountEventCount(
  app: FastifyInstance,
  userId: string,
  conversationId: string,
  eventType: string,
): number {
  return (
    app.db
      .prepare(`
        SELECT COUNT(*) AS n FROM chat_sync_events
        WHERE scope = 'account' AND user_id = ? AND conversation_id = ? AND event_type = ?
      `)
      .get(userId, conversationId, eventType) as { n: number }
  ).n
}

function conversationEventCount(app: FastifyInstance, conversationId: string, eventType: string): number {
  return (
    app.db
      .prepare(`
        SELECT COUNT(*) AS n FROM chat_sync_events
        WHERE scope = 'conversation' AND conversation_id = ? AND event_type = ?
      `)
      .get(conversationId, eventType) as { n: number }
  ).n
}

function defaultBotId(app: FastifyInstance, userId: string): string {
  return (app.db.prepare(`SELECT id FROM bots WHERE user_id = ? AND is_default = 1`).get(userId) as { id: string })
    .id
}
