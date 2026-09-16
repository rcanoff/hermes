import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'
import * as password from '../src/services/password.js'

describe('login field type validation', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    await seedTestUser(app, 'operator', 'password123')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await app.close()
  })

  it.each([
    { name: 'array body', payload: [] },
    { name: 'missing fields', payload: {} },
    { name: 'numeric username', payload: { username: 1, password: 'password123' } },
    { name: 'object username', payload: { username: { n: 'operator' }, password: 'password123' } },
    { name: 'non-string password', payload: { username: 'operator', password: 123 } },
  ])('returns 400 invalid_request for $name without verifying password', async ({ payload }) => {
    const verify = vi.spyOn(password, 'verifyPassword')

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('still authenticates valid string credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('token')
  })

  it('keeps empty string credentials on the 401 path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: '' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'invalid_credentials' })
  })
})
