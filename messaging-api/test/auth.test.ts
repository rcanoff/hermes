import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { closeDb } from '../src/db/index.js'
import { createTestApp } from './helpers/app.js'

describe('auth routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await createTestApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('logs in the bootstrap user and returns a JWT', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('token')
  })

  it('rejects invalid credentials', async () => {
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
    const { id } = me.json() as { id: string }

    app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
    app.db.prepare('DELETE FROM users WHERE id = ?').run(id)

    const deletedUserResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(deletedUserResponse.statusCode).toBe(401)
  })
})

describe('bootstrap user reconciliation', () => {
  it('updates the bootstrap user password on restart when config changes', async () => {
    const dbPath = path.join(os.tmpdir(), `messaging-api-auth-${Date.now()}.sqlite`)

    try {
      const firstApp = await createTestApp({ dbPath, bootstrapPassword: 'first-password' })
      await firstApp.ready()

      const firstLogin = await firstApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'operator', password: 'first-password' },
      })

      expect(firstLogin.statusCode).toBe(200)

      await firstApp.close()
      closeDb()

      const secondApp = await createTestApp({ dbPath, bootstrapPassword: 'second-password' })
      await secondApp.ready()

      const oldPasswordLogin = await secondApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'operator', password: 'first-password' },
      })
      const newPasswordLogin = await secondApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'operator', password: 'second-password' },
      })

      expect(oldPasswordLogin.statusCode).toBe(401)
      expect(newPasswordLogin.statusCode).toBe(200)

      await secondApp.close()
      closeDb()
    } finally {
      fs.rmSync(dbPath, { force: true })
    }
  })
})
