import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createJobConversation } from '../src/db/repos/conversations.js'
import { getBotBySlug } from '../src/db/repos/bots.js'
import { initSchema } from '../src/db/schema.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('conversation bot_id', () => {
  let app: FastifyInstance | undefined
  let token: string
  let userId: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    token = seeded.token
    userId = seeded.id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function authHeaders() {
    return { authorization: `Bearer ${token}` }
  }

  it('backfills existing regular conversations to the default bot', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        hermes_session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
    `)

    initSchema(db)

    const defaultBot = getBotBySlug(db, 'default')
    expect(defaultBot).toBeDefined()
    const row = db
      .prepare(`SELECT bot_id, kind FROM conversations WHERE id = 'c1'`)
      .get() as { bot_id: string; kind: string }
    expect(row.kind).toBe('regular')
    expect(row.bot_id).toBe(defaultBot!.id)
  })

  it('POST without bot_id attaches the default bot', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
    })

    expect(create.statusCode).toBe(201)
    const defaultBot = getBotBySlug(app!.db, 'default')
    expect(create.json()).toMatchObject({
      kind: 'regular',
      bot_id: defaultBot!.id,
      peer_bot_id: null,
    })
  })

  it('POST with bot_id attaches that bot', async () => {
    const botResponse = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    expect(botResponse.statusCode).toBe(201)
    const botId = (botResponse.json() as { id: string }).id

    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: botId },
    })

    expect(create.statusCode).toBe(201)
    expect(create.json()).toMatchObject({
      kind: 'regular',
      bot_id: botId,
    })
  })

  it('POST with unknown bot_id returns 404', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: randomUUID() },
    })

    expect(create.statusCode).toBe(404)
    expect(create.json()).toEqual({ error: 'not_found' })
  })

  it('GET ?bot_id= returns only that bot’s regular chats', async () => {
    const travel = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const travelId = (travel.json() as { id: string }).id

    const defaultChat = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
    })
    const travelChat = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: travelId },
    })

    const filtered = await app!.inject({
      method: 'GET',
      url: `/conversations?bot_id=${travelId}`,
      headers: authHeaders(),
    })

    expect(filtered.statusCode).toBe(200)
    const body = filtered.json() as {
      conversations: Array<{ id: string; bot_id: string }>
      _links: { self: { href: string } }
    }
    expect(body.conversations).toHaveLength(1)
    expect(body.conversations[0]!.id).toBe((travelChat.json() as { id: string }).id)
    expect(body.conversations[0]!.bot_id).toBe(travelId)
    expect(body._links.self.href).toBe(`/conversations?limit=20&bot_id=${travelId}`)

    const unfiltered = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: authHeaders(),
    })
    const unfilteredIds = (
      unfiltered.json() as { conversations: Array<{ id: string }> }
    ).conversations.map((row) => row.id)
    expect(unfilteredIds).toEqual(
      expect.arrayContaining([
        (defaultChat.json() as { id: string }).id,
        (travelChat.json() as { id: string }).id,
      ]),
    )
    expect(unfiltered.json()).toMatchObject({
      _links: { self: { href: '/conversations?limit=20' } },
    })
  })

  it('GET with unknown bot_id returns 404', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/conversations?bot_id=${randomUUID()}`,
      headers: authHeaders(),
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'not_found' })
  })

  it('leaves job conversations with bot_id null and out of GET /conversations', async () => {
    const jobId = createJobConversation(app!.db, userId, 'operator', { name: 'Morning digest' })

    const jobs = await app!.inject({
      method: 'GET',
      url: '/jobs',
      headers: authHeaders(),
    })
    expect(jobs.statusCode).toBe(200)
    const jobRow = (jobs.json() as { jobs: Array<{ id: string; bot_id: string | null }> }).jobs[0]
    expect(jobRow).toMatchObject({ id: jobId, kind: 'job', bot_id: null })

    const chats = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: authHeaders(),
    })
    expect(
      (chats.json() as { conversations: Array<{ id: string }> }).conversations.map((row) => row.id),
    ).not.toContain(jobId)
  })
})
