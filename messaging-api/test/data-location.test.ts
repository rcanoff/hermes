import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    lat: 38.7223,
    lon: -9.1393,
    accuracy_m: 12,
    timestamp: '2026-06-13T09:00:00.000Z',
    trigger: 'manual',
    source: 'ios',
    ...overrides,
  }
}

describe('data location routes', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let otherUserToken: string
  let operatorUserId: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    operatorToken = (login.json() as { token: string }).token
    operatorUserId = (
      app.db.prepare('SELECT id FROM users WHERE username = ?').get('operator') as { id: string }
    ).id

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

  it('accepts location events with and without address', async () => {
    const withoutAddress = await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: validPayload(),
    })

    expect(withoutAddress.statusCode).toBe(204)
    expect(withoutAddress.body).toBe('')

    const latestWithoutAddress = await app!.inject({
      method: 'GET',
      url: '/data/location/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(latestWithoutAddress.statusCode).toBe(200)
    expect(latestWithoutAddress.json()).toMatchObject({
      user_id: operatorUserId,
      lat: 38.7223,
      lon: -9.1393,
      accuracy_m: 12,
      timestamp: '2026-06-13T09:00:00.000Z',
      trigger: 'manual',
      source: 'ios',
      address: null,
      address_source: null,
      address_status: 'pending',
    })

    const withAddress = await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: validPayload({
        timestamp: '2026-06-13T10:00:00.000Z',
        lat: 40.4168,
        lon: -3.7038,
        address: 'Madrid, Spain',
      }),
    })

    expect(withAddress.statusCode).toBe(204)

    const latestWithAddress = await app!.inject({
      method: 'GET',
      url: '/data/location/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(latestWithAddress.statusCode).toBe(200)
    expect(latestWithAddress.json()).toMatchObject({
      lat: 40.4168,
      lon: -3.7038,
      timestamp: '2026-06-13T10:00:00.000Z',
      address: 'Madrid, Spain',
      address_source: 'ios',
      address_status: 'resolved',
    })
  })

  it('rejects invalid trigger and timestamp payloads', async () => {
    const invalidTrigger = await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: validPayload({ trigger: 'gps' }),
    })

    expect(invalidTrigger.statusCode).toBe(400)
    expect(invalidTrigger.json()).toEqual({ error: 'invalid_request' })

    const invalidTimestamp = await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: validPayload({ timestamp: 'not-a-date' }),
    })

    expect(invalidTimestamp.statusCode).toBe(400)
    expect(invalidTimestamp.json()).toEqual({ error: 'invalid_request' })
  })

  it('returns latest location or 404 when none exist', async () => {
    const missing = await app!.inject({
      method: 'GET',
      url: '/data/location/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: 'not_found' })

    await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: validPayload(),
    })

    const latest = await app!.inject({
      method: 'GET',
      url: '/data/location/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(latest.statusCode).toBe(200)
    expect(latest.json()).toMatchObject({
      user_id: operatorUserId,
      lat: 38.7223,
      lon: -9.1393,
    })
  })

  it('lists paginated location history newest first', async () => {
    const timestamps = [
      '2026-06-13T09:00:00.000Z',
      '2026-06-13T10:00:00.000Z',
      '2026-06-13T11:00:00.000Z',
    ]

    const createdIds: string[] = []
    for (const [index, timestamp] of timestamps.entries()) {
      await app!.inject({
        method: 'POST',
        url: '/data/location/events',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: validPayload({ timestamp, lat: 38 + index }),
      })
      const row = app!.db
        .prepare('SELECT id FROM location_events WHERE timestamp = ?')
        .get(timestamp) as { id: string }
      createdIds.push(row.id)
    }

    const firstPage = await app!.inject({
      method: 'GET',
      url: '/data/location/events?limit=2',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(firstPage.statusCode).toBe(200)
    expect(firstPage.json()).toEqual({
      events: [
        expect.objectContaining({ id: createdIds[2], timestamp: timestamps[2] }),
        expect.objectContaining({ id: createdIds[1], timestamp: timestamps[1] }),
      ],
    })

    const secondPage = await app!.inject({
      method: 'GET',
      url: `/data/location/events?limit=2&before=${createdIds[1]}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(secondPage.statusCode).toBe(200)
    expect(secondPage.json()).toEqual({
      events: [expect.objectContaining({ id: createdIds[0], timestamp: timestamps[0] })],
    })
  })

  it('returns 401 without a bearer token', async () => {
    const post = await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      payload: validPayload(),
    })
    const latest = await app!.inject({
      method: 'GET',
      url: '/data/location/latest',
    })
    const events = await app!.inject({
      method: 'GET',
      url: '/data/location/events',
    })

    expect(post.statusCode).toBe(401)
    expect(latest.statusCode).toBe(401)
    expect(events.statusCode).toBe(401)
  })

  it('isolates location data per user', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: validPayload(),
    })

    const otherUserLatest = await app!.inject({
      method: 'GET',
      url: '/data/location/latest',
      headers: { authorization: `Bearer ${otherUserToken}` },
    })

    expect(otherUserLatest.statusCode).toBe(404)
    expect(otherUserLatest.json()).toEqual({ error: 'not_found' })
  })
})