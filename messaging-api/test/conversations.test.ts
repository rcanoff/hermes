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

  it('patches a conversation title for its owner', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: '  My thread  ' },
    })

    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({
      id: conversation.id,
      title: 'My thread',
    })

    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(list.json()).toEqual([patch.json()])
  })

  it('rejects empty or oversized titles', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const empty = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: '   ' },
    })

    const oversized = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: 'a'.repeat(121) },
    })

    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toEqual({ error: 'invalid_request' })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.json()).toEqual({ error: 'invalid_request' })
  })

  it('returns 404 when patching another user conversation', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${otherUserToken}` },
      payload: { title: 'Nope' },
    })

    expect(patch.statusCode).toBe(404)
    expect(patch.json()).toEqual({ error: 'not_found' })
  })
})
