import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'

describe('conversation routes', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let otherUserToken: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    operatorToken = (login.json() as { token: string }).token

    const otherUserId = randomUUID()
    app.db
      .prepare(`
        INSERT INTO users (id, username, password_hash)
        VALUES (?, ?, ?)
      `)
      .run(otherUserId, 'other-user', 'unused-hash')
    otherUserToken = await app.jwt.sign({ sub: otherUserId, username: 'other-user' })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('creates and lists user-owned conversations', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(create.statusCode).toBe(201)
    expect(create.json()).toMatchObject({
      id: expect.any(String),
      user_id: expect.any(String),
      hermes_session_id: expect.any(String),
      title: null,
      created_at: expect.any(String),
    })

    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(list.statusCode).toBe(200)
    expect(list.json()).toHaveLength(1)
    expect(list.json()).toEqual([create.json()])
  })

  it('gets a conversation for its owner and returns 404 for missing or unauthorized access', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const createdConversation = create.json() as { id: string }

    const ownFetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${createdConversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const unauthorizedFetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${createdConversation.id}`,
      headers: { authorization: `Bearer ${otherUserToken}` },
    })
    const missingFetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${randomUUID()}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(ownFetch.statusCode).toBe(200)
    expect(ownFetch.json()).toEqual(create.json())
    expect(unauthorizedFetch.statusCode).toBe(404)
    expect(unauthorizedFetch.json()).toEqual({ error: 'not_found' })
    expect(missingFetch.statusCode).toBe(404)
    expect(missingFetch.json()).toEqual({ error: 'not_found' })
  })

  it('requires authentication', async () => {
    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
    })
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
    })

    expect(list.statusCode).toBe(401)
    expect(create.statusCode).toBe(401)
  })
})
