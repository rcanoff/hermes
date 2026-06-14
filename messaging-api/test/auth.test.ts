import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('auth routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('logs in a seeded user and returns a JWT', async () => {
    await seedTestUser(app, 'operator', 'password123')
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('token')
  })

  it('rejects invalid credentials', async () => {
    await seedTestUser(app, 'operator', 'password123')
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'wrong-password' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'invalid_credentials' })
  })

  it('rejects missing or malformed login bodies with a client error', async () => {
    const missingBody = await app.inject({
      method: 'POST',
      url: '/auth/login',
    })
    const nullBody = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: null,
    })
    const stringBody = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '"not-an-object"',
    })

    expect(missingBody.statusCode).toBe(400)
    expect(missingBody.json()).toEqual({ error: 'invalid_request' })
    expect(nullBody.statusCode).toBe(400)
    expect(nullBody.json()).toEqual({ error: 'invalid_request' })
    expect(stringBody.statusCode).toBe(400)
    expect(stringBody.json()).toEqual({ error: 'invalid_request' })
  })

  it('requires authentication for /auth/me', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns the current user and denies the token after logout', async () => {
    await seedTestUser(app, 'operator', 'password123')
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    const { token } = login.json() as { token: string }

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({
      id: expect.any(String),
      username: 'operator',
    })

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(logout.statusCode).toBe(200)
    expect(logout.json()).toEqual({ ok: true })

    const denied = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(denied.statusCode).toBe(401)
  })

  it('rejects tokens for users that no longer exist', async () => {
    const seeded = await seedTestUser(app, 'operator', 'password123')
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${seeded.token}` },
    })
    const { id } = me.json() as { id: string }

    app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
    app.db.prepare('DELETE FROM users WHERE id = ?').run(id)

    const deletedUserResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${seeded.token}` },
    })

    expect(deletedUserResponse.statusCode).toBe(401)
  })

  it('rejects JWTs issued before password_changed_at', async () => {
    const { id, token } = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`UPDATE users SET password_changed_at = ? WHERE id = ?`).run(
      new Date(Date.now() + 60_000).toISOString(),
      id,
    )

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(me.statusCode).toBe(401)
  })
})