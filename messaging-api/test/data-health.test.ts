import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

function sampleMetrics(overrides: Record<string, unknown> = {}) {
  return {
    steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
    ...overrides,
  }
}

function upsertPayload(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-06-17',
    timezone: 'Europe/Lisbon',
    partial: true,
    source: 'healthkit',
    metrics: sampleMetrics(),
    ...overrides,
  }
}

describe('data health routes', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let otherUserToken: string
  let operatorUserId: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token
    operatorUserId = seeded.id

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

  it('POST upsert inserts a new daily summary with 204', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: upsertPayload(),
    })

    expect(response.statusCode).toBe(204)
    expect(response.body).toBe('')

    const latest = await app!.inject({
      method: 'GET',
      url: '/data/health/daily-summaries/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(latest.statusCode).toBe(200)
    expect(latest.json()).toMatchObject({
      user_id: operatorUserId,
      date: '2026-06-17',
      timezone: 'Europe/Lisbon',
      partial: true,
      source: 'healthkit',
      metrics: sampleMetrics(),
      finalized_at: null,
    })
  })

  it('POST upsert updates the same day', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: upsertPayload(),
    })

    const firstRow = app!.db
      .prepare('SELECT synced_at FROM health_daily_summaries WHERE user_id = ? AND date = ?')
      .get(operatorUserId, '2026-06-17') as { synced_at: string }

    await new Promise((resolve) => setTimeout(resolve, 1100))

    const response = await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: upsertPayload({
        metrics: sampleMetrics({
          steps: { value: 7000, unit: 'count', goal: 10000, remaining: 3000 },
        }),
      }),
    })

    expect(response.statusCode).toBe(204)

    const latest = await app!.inject({
      method: 'GET',
      url: '/data/health/daily-summaries/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(latest.statusCode).toBe(200)
    expect(latest.json()).toMatchObject({
      metrics: {
        steps: { value: 7000, unit: 'count', goal: 10000, remaining: 3000 },
      },
    })

    const secondRow = app!.db
      .prepare('SELECT synced_at FROM health_daily_summaries WHERE user_id = ? AND date = ?')
      .get(operatorUserId, '2026-06-17') as { synced_at: string }

    expect(secondRow.synced_at).not.toBe(firstRow.synced_at)
  })

  it('POST finalize with partial false sets finalized_at', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: upsertPayload({ partial: false }),
    })

    const latest = await app!.inject({
      method: 'GET',
      url: '/data/health/daily-summaries/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(latest.statusCode).toBe(200)
    const body = latest.json() as { partial: boolean; finalized_at: string | null }
    expect(body.partial).toBe(false)
    expect(body.finalized_at).toBeTruthy()
  })

  it('POST partial true on a finalized day returns 409 day_finalized', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: upsertPayload({ partial: false }),
    })

    const response = await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: upsertPayload({ partial: true }),
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'day_finalized' })
  })

  it('POST rejects invalid remaining with 400', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: upsertPayload({
        metrics: sampleMetrics({
          steps: { value: 100, unit: 'count', goal: 1000, remaining: 500 },
        }),
      }),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
  })

  it('GET latest returns 404 when empty', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/data/health/daily-summaries/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'not_found' })
  })

  it('GET latest returns the newest date', async () => {
    const dates = ['2026-06-15', '2026-06-16', '2026-06-17']

    for (const date of dates) {
      await app!.inject({
        method: 'POST',
        url: '/data/health/daily-summaries',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: upsertPayload({ date }),
      })
    }

    const latest = await app!.inject({
      method: 'GET',
      url: '/data/health/daily-summaries/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(latest.statusCode).toBe(200)
    expect(latest.json()).toMatchObject({ date: '2026-06-17' })
  })

  it('GET list returns HAL pagination with before and after', async () => {
    const dates = ['2026-06-15', '2026-06-16', '2026-06-17']
    const createdIds: string[] = []

    for (const date of dates) {
      await app!.inject({
        method: 'POST',
        url: '/data/health/daily-summaries',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: upsertPayload({ date }),
      })

      const row = app!.db
        .prepare('SELECT id FROM health_daily_summaries WHERE user_id = ? AND date = ?')
        .get(operatorUserId, date) as { id: string }
      createdIds.push(row.id)
    }

    const firstPage = await app!.inject({
      method: 'GET',
      url: '/data/health/daily-summaries?limit=2',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(firstPage.statusCode).toBe(200)
    expect(firstPage.json()).toEqual({
      summaries: [
        expect.objectContaining({ id: createdIds[2], date: dates[2] }),
        expect.objectContaining({ id: createdIds[1], date: dates[1] }),
      ],
      _links: {
        self: { href: '/data/health/daily-summaries?limit=2' },
        next: { href: `/data/health/daily-summaries?limit=2&before=${createdIds[1]}` },
      },
    })

    const secondPage = await app!.inject({
      method: 'GET',
      url: (firstPage.json() as { _links: { next: { href: string } } })._links.next.href,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(secondPage.statusCode).toBe(200)
    expect(secondPage.json()).toEqual({
      summaries: [expect.objectContaining({ id: createdIds[0], date: dates[0] })],
      _links: {
        self: { href: `/data/health/daily-summaries?limit=2&before=${createdIds[1]}` },
        prev: { href: `/data/health/daily-summaries?limit=2&after=${createdIds[0]}` },
      },
    })
  })

  it('upserts and returns v2 health metrics', async () => {
    const metrics = {
      steps: { value: 5000, unit: 'count', goal: 10000, remaining: 5000 },
      sleep_duration: { value: 390, unit: 'min', goal: null, remaining: null },
      resting_heart_rate: { value: 60, unit: 'bpm', goal: null, remaining: null },
      workout_count: { value: 1, unit: 'count', goal: null, remaining: null },
      workout_minutes: { value: 32, unit: 'min', goal: null, remaining: null },
      workout_types: { types: ['running'] },
      water: { value: 1500, unit: 'ml', goal: null, remaining: null },
    }

    const upsert = await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        date: '2026-06-18',
        timezone: 'Europe/Lisbon',
        partial: true,
        source: 'healthkit',
        metrics,
      },
    })
    expect(upsert.statusCode).toBe(204)

    const latest = await app!.inject({
      method: 'GET',
      url: '/data/health/daily-summaries/latest',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(latest.statusCode).toBe(200)
    const body = latest.json() as {
      metrics: {
        sleep_duration: { value: number }
        workout_types: { types: string[] }
      }
    }
    expect(body.metrics.sleep_duration.value).toBe(390)
    expect(body.metrics.workout_types.types).toEqual(['running'])
  })

  it('isolates health data per user', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: upsertPayload(),
    })

    const otherUserLatest = await app!.inject({
      method: 'GET',
      url: '/data/health/daily-summaries/latest',
      headers: { authorization: `Bearer ${otherUserToken}` },
    })

    expect(otherUserLatest.statusCode).toBe(404)
    expect(otherUserLatest.json()).toEqual({ error: 'not_found' })
  })
})