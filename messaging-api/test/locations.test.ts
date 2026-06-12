import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'

describe('location routes', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let otherUserToken: string
  let conversationId: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    operatorToken = (login.json() as { token: string }).token

    const createConversation = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    conversationId = (createConversation.json() as { id: string }).id

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

  it('upserts, reads, and deletes the latest location for a conversation', async () => {
    const update = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/location`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        lat: 38.7223,
        lon: -9.1393,
        accuracy_m: 12,
        timestamp: '2026-06-13T09:00:00.000Z',
        mode: 'once',
        source: 'ios',
      },
    })

    expect(update.statusCode).toBe(204)

    const fetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/location/latest`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(fetch.statusCode).toBe(200)
    expect(fetch.json()).toMatchObject({
      id: expect.any(String),
      conversation_id: conversationId,
      lat: 38.7223,
      lon: -9.1393,
      accuracy_m: 12,
      timestamp: '2026-06-13T09:00:00.000Z',
      mode: 'once',
      source: 'ios',
      updated_at: expect.any(String),
    })

    const secondUpdate = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/location`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        lat: 40.4168,
        lon: -3.7038,
        accuracy_m: 8,
        timestamp: '2026-06-13T10:00:00.000Z',
        mode: 'watch',
        source: 'ios',
      },
    })
    const afterSecondUpdate = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/location/latest`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(secondUpdate.statusCode).toBe(204)
    expect(afterSecondUpdate.statusCode).toBe(200)
    expect(afterSecondUpdate.json()).toMatchObject({
      id: (fetch.json() as { id: string }).id,
      conversation_id: conversationId,
      lat: 40.4168,
      lon: -3.7038,
      accuracy_m: 8,
      timestamp: '2026-06-13T10:00:00.000Z',
      mode: 'watch',
      source: 'ios',
    })

    const remove = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}/location`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const fetchAfterDelete = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/location/latest`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(remove.statusCode).toBe(204)
    expect(fetchAfterDelete.statusCode).toBe(404)
    expect(fetchAfterDelete.json()).toEqual({ error: 'not_found' })
  })

  it('returns 404 for missing or unauthorized conversation-scoped location access', async () => {
    const unauthorizedFetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/location/latest`,
      headers: { authorization: `Bearer ${otherUserToken}` },
    })
    const unauthorizedUpdate = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/location`,
      headers: { authorization: `Bearer ${otherUserToken}` },
      payload: {
        lat: 1,
        lon: 2,
        accuracy_m: 3,
        timestamp: '2026-06-13T11:00:00.000Z',
        mode: 'once',
        source: 'ios',
      },
    })
    const missingDelete = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${randomUUID()}/location`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(unauthorizedFetch.statusCode).toBe(404)
    expect(unauthorizedFetch.json()).toEqual({ error: 'not_found' })
    expect(unauthorizedUpdate.statusCode).toBe(404)
    expect(unauthorizedUpdate.json()).toEqual({ error: 'not_found' })
    expect(missingDelete.statusCode).toBe(404)
    expect(missingDelete.json()).toEqual({ error: 'not_found' })
  })

  it('rejects invalid location payloads', async () => {
    const invalidCases = [
      {
        name: 'non-finite latitude',
        payload: '{"lat":1e309,"lon":-9.1393,"accuracy_m":12,"timestamp":"2026-06-13T09:00:00.000Z","mode":"once","source":"ios"}',
      },
      {
        name: 'out-of-range latitude',
        payload: {
          lat: 91,
          lon: -9.1393,
          accuracy_m: 12,
          timestamp: '2026-06-13T09:00:00.000Z',
          mode: 'once',
          source: 'ios',
        },
      },
      {
        name: 'out-of-range longitude',
        payload: {
          lat: 38.7223,
          lon: -181,
          accuracy_m: 12,
          timestamp: '2026-06-13T09:00:00.000Z',
          mode: 'once',
          source: 'ios',
        },
      },
      {
        name: 'negative accuracy',
        payload: {
          lat: 38.7223,
          lon: -9.1393,
          accuracy_m: -1,
          timestamp: '2026-06-13T09:00:00.000Z',
          mode: 'once',
          source: 'ios',
        },
      },
      {
        name: 'invalid timestamp',
        payload: {
          lat: 38.7223,
          lon: -9.1393,
          accuracy_m: 12,
          timestamp: 'not-a-date',
          mode: 'once',
          source: 'ios',
        },
      },
      {
        name: 'non-iso timestamp',
        payload: {
          lat: 38.7223,
          lon: -9.1393,
          accuracy_m: 12,
          timestamp: '2026-06-13 09:00:00Z',
          mode: 'once',
          source: 'ios',
        },
      },
    ]

    for (const testCase of invalidCases) {
      const response = await app!.inject({
        method: 'POST',
        url: `/conversations/${conversationId}/location`,
        headers: {
          authorization: `Bearer ${operatorToken}`,
          ...(typeof testCase.payload === 'string' ? { 'content-type': 'application/json' } : {}),
        },
        payload: testCase.payload,
      })

      expect(response.statusCode, testCase.name).toBe(400)
      expect(response.json(), testCase.name).toEqual({ error: 'invalid_request' })
    }
  })
})
