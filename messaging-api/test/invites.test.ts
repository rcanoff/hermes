import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'
import { createInviteRecord } from '../src/services/invites.js'

describe('invite routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns invite metadata for a valid activation token', async () => {
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'GET',
      url: `/auth/invite/${rawToken}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      valid: true,
      type: 'activation',
      expires_at: expect.any(String),
    })
  })

  it('activates a new account and returns a JWT', async () => {
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: {
        token: rawToken,
        username: 'roberto',
        password: 'secure-password1',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('token')

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'roberto', password: 'secure-password1' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('returns 409 when username is taken', async () => {
    await seedTestUser(app, 'roberto', 'existing-password1')
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: {
        token: rawToken,
        username: 'roberto',
        password: 'secure-password1',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'username_taken' })
  })

  it('resets password and invalidates old JWT', async () => {
    const seeded = await seedTestUser(app, 'roberto', 'old-password12')
    const { rawToken } = createInviteRecord(app.db, {
      type: 'password_reset',
      userId: seeded.id,
      expiryHours: 48,
    })

    const reset = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, password: 'new-password123' },
    })
    expect(reset.statusCode).toBe(200)

    const denied = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${seeded.token}` },
    })
    expect(denied.statusCode).toBe(401)
  })

  it('does not create users on startup', async () => {
    const count = app.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
    expect(count.count).toBe(0)
  })

  it('rejects login when no users exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'nobody', password: 'secure-password1' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('redirects invite landing to app deep link', async () => {
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'GET',
      url: `/invite/${rawToken}`,
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe(`hermes-companion://invite/${rawToken}`)
  })
})