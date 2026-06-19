import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { listPushDevicesByUserId } from '../src/db/repos/push-devices.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('push routes', () => {
  let app: FastifyInstance | undefined
  let token: string
  let userId: string
  const deviceToken = 'dd'.repeat(32)

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'alice', 'password123')
    token = seeded.token
    userId = seeded.id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('PUT /push/device upserts token', async () => {
    const response = await app!.inject({
      method: 'PUT',
      url: '/push/device',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_token: deviceToken, environment: 'development' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })

    const rows = listPushDevicesByUserId(app!.db, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.device_token).toBe(deviceToken)
    expect(rows[0]?.session_id).toBeTruthy()
  })

  it('rejects invalid token format', async () => {
    const response = await app!.inject({
      method: 'PUT',
      url: '/push/device',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_token: 'nope', environment: 'development' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('DELETE /push/device removes token', async () => {
    await app!.inject({
      method: 'PUT',
      url: '/push/device',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_token: deviceToken, environment: 'development' },
    })

    const response = await app!.inject({
      method: 'DELETE',
      url: '/push/device',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_token: deviceToken },
    })

    expect(response.statusCode).toBe(200)
    expect(listPushDevicesByUserId(app!.db, userId)).toHaveLength(0)
  })
})