import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { SessionStreamEvent } from '../src/streams/hub.js'
import { createTestApp } from './helpers/app.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { seedTestUser } from './helpers/users.js'

describe('message delivery', () => {
  let app: FastifyInstance | undefined

  beforeEach(async () => {
    app = await createTestApp({ hermesClient: new FakeHermesClient() })
    await app.ready()
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function dmWithMessage() {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const dm = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { kind: 'user_dm', participant_user_ids: [bob.id] },
    })
    const dmId = String(dm.json().id)
    const sent = await app!.inject({
      method: 'POST',
      url: `/conversations/${dmId}/messages`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { text: 'hey bob', client_message_id: randomUUID() },
    })
    return { alice, bob, dmId, messageId: String(sent.json().message.id) }
  }

  function markDelivered(token: string, dmId: string, messageId: string) {
    return app!.inject({
      method: 'POST',
      url: `/conversations/${dmId}/messages/${messageId}/delivered`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('recipient_can_mark_delivered_once', async () => {
    const { alice, bob, dmId, messageId } = await dmWithMessage()
    const published: Array<{ userId: string; event: SessionStreamEvent }> = []
    const original = app!.streamHub.publishToUser.bind(app!.streamHub)
    app!.streamHub.publishToUser = (userId, event) => {
      published.push({ userId, event })
      original(userId, event)
    }

    const first = await markDelivered(bob.token, dmId, messageId)
    const second = await markDelivered(bob.token, dmId, messageId)

    expect(first.statusCode).toBe(204)
    expect(second.statusCode).toBe(204)
    const rows = app!.db
      .prepare(`SELECT message_id, user_id, delivered_at FROM message_deliveries`)
      .all() as Array<{ message_id: string; user_id: string; delivered_at: string }>
    expect(rows).toEqual([{ message_id: messageId, user_id: bob.id, delivered_at: expect.any(String) }])
    const at = rows[0]!.delivered_at

    const listed = await app!.inject({
      method: 'GET',
      url: `/conversations/${dmId}/messages`,
      headers: { authorization: `Bearer ${alice.token}` },
    })
    expect(listed.json().messages[0].delivered_by).toEqual([{ user_id: bob.id, at }])

    const delivered = published.filter((row) => row.event.event === 'message_delivered')
    expect(delivered).toEqual([
      {
        userId: alice.id,
        event: { event: 'message_delivered', data: { conversationId: dmId, messageId, actorId: bob.id, at } },
      },
    ])

    const sync = await app!.inject({
      method: 'GET',
      url: `/conversations/${dmId}/sync`,
      headers: { authorization: `Bearer ${alice.token}` },
    })
    const events = sync.json().events.filter((event: { type: string }) => event.type === 'message_delivered')
    expect(events).toEqual([
      {
        event_id: expect.any(String),
        type: 'message_delivered',
        occurred_at: expect.any(String),
        message_id: messageId,
        actor_id: bob.id,
        at,
      },
    ])
    const upsert = sync.json().events.find((event: { type: string }) => event.type === 'message_upsert')
    expect(upsert.message.delivered_by).toEqual([])
  })

  it('serialises an empty delivered_by on a fresh message', async () => {
    const { alice, dmId } = await dmWithMessage()
    const sent = await app!.inject({
      method: 'POST',
      url: `/conversations/${dmId}/messages`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { text: 'again', client_message_id: randomUUID() },
    })

    expect(sent.json().message.delivered_by).toEqual([])
  })

  it('sender_cannot_mark_own_message_delivered', async () => {
    const { alice, dmId, messageId } = await dmWithMessage()

    const response = await markDelivered(alice.token, dmId, messageId)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'forbidden' })
    expect(app!.db.prepare(`SELECT COUNT(*) AS n FROM message_deliveries`).get()).toEqual({ n: 0 })
  })

  it('non_member_cannot_mark_delivered', async () => {
    const { dmId, messageId } = await dmWithMessage()
    const carol = await seedTestUser(app!, 'carol', 'password123')

    const response = await markDelivered(carol.token, dmId, messageId)

    expect(response.statusCode).toBe(404)
    expect(app!.db.prepare(`SELECT COUNT(*) AS n FROM message_deliveries`).get()).toEqual({ n: 0 })
  })

  it('returns 404 for a message outside the conversation', async () => {
    const { bob, dmId } = await dmWithMessage()

    const response = await markDelivered(bob.token, dmId, randomUUID())

    expect(response.statusCode).toBe(404)
  })
})
