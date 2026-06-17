import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { createUser } from '../src/db/repos/users.js'
import { hashPassword } from '../src/services/password.js'

describe('auth session jti', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    const passwordHash = await hashPassword('password123')
    createUser(app.db, {
      username: 'operator',
      passwordHash,
      passwordChangedAt: new Date().toISOString(),
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('includes jti in login JWT payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })

    expect(response.statusCode).toBe(200)
    const { token } = response.json() as { token: string }
    const claims = app.jwt.decode<{ jti?: string; sub: string }>(token)
    expect(claims?.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(claims?.sub).toBeTruthy()
  })
})