import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sharedConversationTitle } from '../src/db/repos/conversations.js'
import { finishGroupRun } from '../src/db/repos/group-bot-runs.js'
import { createTestApp } from './helpers/app.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { seedTestUser } from './helpers/users.js'

describe('sharedConversationTitle', () => {
  it('sorts names and drops trailing ones past 120 characters', () => {
    expect(sharedConversationTitle(['bob', 'amy'])).toBe('amy, bob')
    expect(sharedConversationTitle(['a'.repeat(130)])).toBe('a'.repeat(120))
    expect(
      sharedConversationTitle(['c'.repeat(50), 'a'.repeat(50), 'b'.repeat(50)]),
    ).toBe(`${'a'.repeat(50)}, ${'b'.repeat(50)}`)
  })
})

describe('shared conversation create', () => {
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

  it('lists other users sorted by username', async () => {
    const mia = await seedTestUser(app!, 'mia', 'password123')
    await seedTestUser(app!, 'zed', 'password123')
    await seedTestUser(app!, 'amy', 'password123')

    const response = await app!.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${mia.token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().users.map((user: { username: string }) => user.username)).toEqual([
      'amy',
      'zed',
    ])
  })

  it('rejects a self id without storing a conversation', async () => {
    const caller = await seedTestUser(app!, 'caller', 'password123')
    const before = countConversations(app!)

    const response = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${caller.token}` },
      payload: { kind: 'user_dm', participant_user_ids: [caller.id] },
    })

    expect(response.statusCode).toBe(400)
    expect(countConversations(app!)).toBe(before)
  })

  it('opens one DM when two creates race', async () => {
    const caller = await seedTestUser(app!, 'caller', 'password123')
    const peer = await seedTestUser(app!, 'peer', 'password123')
    const payload = { kind: 'user_dm', participant_user_ids: [peer.id] }
    const headers = { authorization: `Bearer ${caller.token}` }

    const [first, second] = await Promise.all([
      app!.inject({ method: 'POST', url: '/conversations', headers, payload }),
      app!.inject({ method: 'POST', url: '/conversations', headers, payload }),
    ])

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201])
    expect(first.json().id).toBe(second.json().id)
    expect(first.json()).toMatchObject({
      kind: 'user_dm',
      title: peer.username,
      bot_id: null,
      peer_bot_id: null,
      bot: null,
      members: [
        { id: caller.id, username: caller.username },
        { id: peer.id, username: peer.username },
      ],
    })
    expect(countKind(app!, 'user_dm')).toBe(1)
    expect(memberIds(app!, first.json().id).sort()).toEqual([caller.id, peer.id].sort())
    expect(upsertUserIds(app!, first.json().id).sort()).toEqual([caller.id, peer.id].sort())
    expect(hermes.ensureSessionRequests).toEqual([])
  })

  it('does not collapse two identical group creates', async () => {
    const caller = await seedTestUser(app!, 'caller', 'password123')
    const peer = await seedTestUser(app!, 'peer', 'password123')
    const botId = defaultBotId(app!, caller.id)
    const payload = { kind: 'group', participant_user_ids: [peer.id], bot_id: botId }
    const headers = { authorization: `Bearer ${caller.token}` }

    const first = await app!.inject({ method: 'POST', url: '/conversations', headers, payload })
    const second = await app!.inject({ method: 'POST', url: '/conversations', headers, payload })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(first.json().id).not.toBe(second.json().id)
    const members = [
      { id: caller.id, username: caller.username },
      { id: peer.id, username: peer.username },
    ]
    expect(first.json()).toMatchObject({
      kind: 'group',
      title: sharedConversationTitle([caller.username, peer.username]),
      bot_id: botId,
      peer_bot_id: null,
      members,
    })
    expect(first.json().bot).toMatchObject({ id: botId })
    expect(first.json().bot).not.toHaveProperty('soul')
    expect(first.json().bot).not.toHaveProperty('role')
    expect(first.json().bot).not.toHaveProperty('responsibilities')

    const got = await app!.inject({
      method: 'GET',
      url: `/conversations/${first.json().id}`,
      headers,
    })
    const listed = await app!.inject({
      method: 'GET',
      url: '/conversations?include_shared=true',
      headers,
    })
    const item = listed.json().conversations.find((row: { id: string }) => row.id === first.json().id)

    expect(got.json().members).toEqual(members)
    expect(got.json().bot).toEqual(first.json().bot)
    expect(item.members).toEqual(members)
    expect(item.bot).toEqual(first.json().bot)
    expect(countKind(app!, 'group')).toBe(2)
    expect(hermes.ensureSessionRequests).toEqual([])
  })

  it('sync entry includes members and bot and not soul', async () => {
    const caller = await seedTestUser(app!, 'caller', 'password123')
    const peer = await seedTestUser(app!, 'peer', 'password123')
    const bot = app!.db
      .prepare(`SELECT id, name, icon, color, soul FROM bots WHERE user_id = ? AND is_default = 1`)
      .get(caller.id) as { id: string; name: string; icon: string; color: string; soul: string }
    const created = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${caller.token}` },
      payload: { kind: 'group', participant_user_ids: [peer.id], bot_id: bot.id },
    })
    const stored = app!.db
      .prepare(`
        SELECT payload_json FROM chat_sync_events
        WHERE conversation_id = ? AND user_id = ? AND event_type = 'conversation_upsert'
      `)
      .get(created.json().id, caller.id) as { payload_json: string }
    const entry = JSON.parse(stored.payload_json).conversation as {
      members: Array<{ id: string; username: string }>
      bot: { id: string; name: string; icon: string; color: string }
    }

    expect(entry.members).toEqual([
      { id: caller.id, username: caller.username },
      { id: peer.id, username: peer.username },
    ])
    expect(entry.bot).toEqual({ id: bot.id, name: bot.name, icon: bot.icon, color: bot.color })
    expect(entry.bot).not.toHaveProperty('soul')
    expect(JSON.stringify(entry)).not.toContain(bot.soul)
  })

  it('rejects shared title and model patches', async () => {
    const caller = await seedTestUser(app!, 'caller', 'password123')
    const peer = await seedTestUser(app!, 'peer', 'password123')
    const headers = { authorization: `Bearer ${caller.token}` }
    const peerHeaders = { authorization: `Bearer ${peer.token}` }
    const dm = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers,
      payload: { kind: 'user_dm', participant_user_ids: [peer.id] },
    })
    const group = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers,
      payload: {
        kind: 'group',
        participant_user_ids: [peer.id],
        bot_id: defaultBotId(app!, caller.id),
      },
    })

    const dmTitle = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${dm.json().id}`,
      headers,
      payload: { title: 'Nope' },
    })
    const memberTitle = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${group.json().id}`,
      headers: peerHeaders,
      payload: { title: 'Nope' },
    })
    const memberModel = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${group.json().id}`,
      headers: peerHeaders,
      payload: { model: 'grok-4.3', provider: 'xai-oauth' },
    })
    const creatorTitle = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${group.json().id}`,
      headers,
      payload: { title: 'Renamed' },
    })
    const creatorModel = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${group.json().id}`,
      headers,
      payload: { model: 'grok-4.3', provider: 'xai-oauth' },
    })

    expect(dmTitle.statusCode).toBe(400)
    expect(memberTitle.statusCode).toBe(403)
    expect(memberTitle.json()).toEqual({ error: 'creator_required' })
    expect(memberModel.statusCode).toBe(400)
    expect(creatorTitle.statusCode).toBe(200)
    expect(creatorTitle.json().title).toBe('Renamed')
    expect(creatorTitle.json().members).toHaveLength(2)
    expect(creatorTitle.json().bot).not.toHaveProperty('soul')
    expect(creatorModel.statusCode).toBe(400)
    expect(hermes.patchSessionModelRequests).toEqual([])
    expect(upsertUserIds(app!, dm.json().id).sort()).toEqual([caller.id, peer.id].sort())
    expect(upsertUserIds(app!, group.json().id).filter((id) => id === caller.id)).toHaveLength(2)
    expect(upsertUserIds(app!, group.json().id).filter((id) => id === peer.id)).toHaveLength(2)
  })
})

describe('shared conversation delete', () => {
  let app: FastifyInstance | undefined

  beforeEach(async () => {
    app = await createTestApp({ hermesClient: new FakeHermesClient() })
    await app.ready()
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('lets only the creator delete a group and keeps the account tombstone', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const cara = await seedTestUser(app!, 'cara', 'password123')
    const aliceHeaders = { authorization: `Bearer ${alice.token}` }
    const bobHeaders = { authorization: `Bearer ${bob.token}` }
    const createdBot = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: aliceHeaders,
      payload: { name: 'Guide', role: 'helper' },
    })
    const botId = createdBot.json().id as string
    const group = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: aliceHeaders,
      payload: { kind: 'group', participant_user_ids: [bob.id], bot_id: botId },
    })
    const groupId = group.json().id as string
    const dm = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: aliceHeaders,
      payload: { kind: 'user_dm', participant_user_ids: [bob.id] },
    })
    const beforeMessages = countMessages(app!)

    for (const id of [groupId, dm.json().id as string]) {
      const headers = aliceHeaders
      const edit = await app!.inject({
        method: 'PATCH',
        url: `/conversations/${id}/messages/${randomUUID()}`,
        headers,
        payload: { text: 'nope' },
      })
      const removed = await app!.inject({
        method: 'DELETE',
        url: `/conversations/${id}/messages/${randomUUID()}`,
        headers,
      })
      const interrupt = await app!.inject({
        method: 'POST',
        url: `/conversations/${id}/run/interrupt`,
        headers,
      })
      const input = await app!.inject({
        method: 'POST',
        url: `/conversations/${id}/messages/${randomUUID()}/input`,
        headers,
        payload: { action: 'deny' },
      })
      expect(edit.statusCode).toBe(409)
      expect(edit.json()).toEqual({ error: 'delete_unavailable' })
      expect(removed.statusCode).toBe(409)
      expect(removed.json()).toEqual({ error: 'delete_unavailable' })
      expect(interrupt.json()).toEqual({ error: 'unavailable' })
      expect(input.json()).toEqual({ error: 'unavailable' })
    }
    expect(countMessages(app!)).toBe(beforeMessages)

    const bobDelete = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${groupId}`,
      headers: bobHeaders,
    })
    const strangerDelete = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${groupId}`,
      headers: { authorization: `Bearer ${cara.token}` },
    })
    const dmDelete = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${dm.json().id}`,
      headers: aliceHeaders,
    })
    const blockedBot = await app!.inject({
      method: 'DELETE',
      url: `/bots/${botId}`,
      headers: aliceHeaders,
    })

    expect(bobDelete.statusCode).toBe(403)
    expect(bobDelete.json()).toEqual({ error: 'creator_required' })
    expect(strangerDelete.statusCode).toBe(404)
    expect(dmDelete.json()).toEqual({ error: 'delete_unavailable' })
    expect(blockedBot.json()).toEqual({ error: 'bot_in_group' })
    expect(countKind(app!, 'group')).toBe(1)

    const renamed = await app!.inject({
      method: 'PATCH',
      url: `/bots/${botId}`,
      headers: aliceHeaders,
      payload: { name: 'Scout' },
    })
    const bobRead = await app!.inject({
      method: 'GET',
      url: `/conversations/${groupId}`,
      headers: bobHeaders,
    })
    const bobBot = await app!.inject({
      method: 'GET',
      url: `/bots/${botId}`,
      headers: bobHeaders,
    })
    expect(renamed.statusCode).toBe(200)
    expect(bobRead.json().bot.name).toBe('Scout')
    expect(bobBot.statusCode).toBe(404)

    const runningId = randomUUID()
    const queuedId = randomUUID()
    app!.db
      .prepare(
        `INSERT INTO group_bot_runs (message_id, conversation_id, state, run_id) VALUES (?, ?, 'running', ?)`,
      )
      .run(runningId, groupId, randomUUID())
    app!.db
      .prepare(
        `INSERT INTO group_bot_runs (message_id, conversation_id, state, run_id) VALUES (?, ?, 'queued', ?)`,
      )
      .run(queuedId, groupId, randomUUID())

    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${groupId}`,
      headers: aliceHeaders,
    })
    expect(deleted.statusCode).toBe(204)
    expect(finishGroupRun(app!.db, runningId, 'running', 'done')).toBe(false)
    expect(finishGroupRun(app!.db, queuedId, 'queued', 'done')).toBe(false)

    const listed = await app!.inject({
      method: 'GET',
      url: '/conversations?include_shared=true',
      headers: bobHeaders,
    })
    expect(listed.json().conversations.some((row: { id: string }) => row.id === groupId)).toBe(false)

    const feed = await app!.inject({
      method: 'GET',
      url: '/conversations/sync?include_shared=true',
      headers: bobHeaders,
    })
    const tombstones = feed
      .json()
      .events.filter(
        (event: { type: string; conversation_id?: string }) =>
          event.type === 'conversation_deleted' && event.conversation_id === groupId,
      )
    expect(tombstones).toHaveLength(1)
    expect(
      feed.json().events.some(
        (event: { type: string; conversation?: { id: string } }) =>
          event.type === 'conversation_upsert' && event.conversation?.id === groupId,
      ),
    ).toBe(false)

    const thread = await app!.inject({
      method: 'GET',
      url: `/conversations/${groupId}/sync`,
      headers: bobHeaders,
    })
    expect(thread.statusCode).toBe(404)
    expect(accountDeletedCount(app!, bob.id, groupId)).toBe(1)

    const removedBot = await app!.inject({
      method: 'DELETE',
      url: `/bots/${botId}`,
      headers: aliceHeaders,
    })
    expect(removedBot.statusCode).toBe(204)
  })
})

function countConversations(app: FastifyInstance): number {
  return (app.db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get() as { n: number }).n
}

function countKind(app: FastifyInstance, kind: string): number {
  return (
    app.db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE kind = ?`).get(kind) as { n: number }
  ).n
}

function memberIds(app: FastifyInstance, conversationId: string): string[] {
  return (
    app.db
      .prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = ?`)
      .all(conversationId) as Array<{ user_id: string }>
  ).map((row) => row.user_id)
}

function upsertUserIds(app: FastifyInstance, conversationId: string): string[] {
  return (
    app.db
      .prepare(`
        SELECT user_id FROM chat_sync_events
        WHERE conversation_id = ? AND event_type = 'conversation_upsert'
      `)
      .all(conversationId) as Array<{ user_id: string }>
  ).map((row) => row.user_id)
}

function countMessages(app: FastifyInstance): number {
  return (app.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n
}

function accountDeletedCount(app: FastifyInstance, userId: string, conversationId: string): number {
  return (
    app.db
      .prepare(
        `
        SELECT COUNT(*) AS n FROM chat_sync_events
        WHERE scope = 'account' AND user_id = ? AND conversation_id = ? AND event_type = 'conversation_deleted'
      `,
      )
      .get(userId, conversationId) as { n: number }
  ).n
}

function defaultBotId(app: FastifyInstance, userId: string): string {
  return (app.db.prepare(`SELECT id FROM bots WHERE user_id = ? AND is_default = 1`).get(userId) as { id: string }).id
}
