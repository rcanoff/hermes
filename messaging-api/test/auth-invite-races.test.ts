import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { consumeInvite, getInviteById, revokeInvite } from '../src/db/repos/account-invites.js'
import { createInviteRecord, lookupInviteByRawToken } from '../src/services/invites.js'
import * as password from '../src/services/password.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

function userCount(app: FastifyInstance): number {
  return (app.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count
}

function installHashBarrier() {
  let started = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = password.hashPassword.bind(password)
  vi.spyOn(password, 'hashPassword').mockImplementation(async (value: string) => {
    started += 1
    await gate
    return original(value)
  })
  return {
    waitForStarters: async (count: number) => {
      await vi.waitFor(() => {
        expect(started).toBe(count)
      })
    },
    release: () => release(),
  }
}

describe('account invite consumption', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await app.close()
  })

  it('consumeInvite marks a still-valid invite and rejects a second consume', () => {
    const { invite } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })
    expect(consumeInvite(app.db, invite.id)).toBe(true)
    expect(getInviteById(app.db, invite.id)?.used_at).toBeTruthy()
    expect(consumeInvite(app.db, invite.id)).toBe(false)
  })

  it('lets only one of two concurrent activations succeed', async () => {
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })
    const barrier = installHashBarrier()

    const first = app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: { token: rawToken, username: 'alice', password: 'secure-password1' },
    })
    const second = app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: { token: rawToken, username: 'bob', password: 'secure-password1' },
    })

    await barrier.waitForStarters(2)
    barrier.release()
    const results = await Promise.all([first, second])

    const statuses = results.map((result) => result.statusCode).sort()
    expect(statuses).toEqual([200, 400])
    expect(results.some((result) => result.json().error === 'invalid_token' || result.statusCode === 400)).toBe(
      true,
    )
    expect(userCount(app)).toBe(1)
  })

  it('does not let the losing password reset overwrite the winner', async () => {
    const seeded = await seedTestUser(app, 'roberto', 'old-password12')
    const { rawToken } = createInviteRecord(app.db, {
      type: 'password_reset',
      userId: seeded.id,
      expiryHours: 48,
    })
    const barrier = installHashBarrier()

    const first = app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, password: 'winner-password1' },
    })
    const second = app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, password: 'loser-password12' },
    })

    await barrier.waitForStarters(2)
    barrier.release()
    const results = await Promise.all([first, second])
    const statuses = results.map((result) => result.statusCode).sort()
    expect(statuses).toEqual([200, 400])

    const winnerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'roberto', password: 'winner-password1' },
    })
    const loserLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'roberto', password: 'loser-password12' },
    })
    expect([winnerLogin.statusCode, loserLogin.statusCode].sort()).toEqual([200, 401])
    expect(winnerLogin.statusCode === 200 || loserLogin.statusCode === 200).toBe(true)
    expect(winnerLogin.statusCode === 401 || loserLogin.statusCode === 401).toBe(true)
  })

  it('preserves 409 username_taken and leaves the invite usable', async () => {
    await seedTestUser(app, 'alice', 'existing-password1')
    const { invite, rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: { token: rawToken, username: 'alice', password: 'secure-password1' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'username_taken' })
    expect(getInviteById(app.db, invite.id)?.used_at).toBeNull()

    const retry = await app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: { token: rawToken, username: 'bob', password: 'secure-password1' },
    })
    expect(retry.statusCode).toBe(200)
  })

  it('rejects activation when the invite is revoked during hashing', async () => {
    const { invite, rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })
    const barrier = installHashBarrier()

    const pending = app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: { token: rawToken, username: 'alice', password: 'secure-password1' },
    })
    await barrier.waitForStarters(1)
    expect(revokeInvite(app.db, invite.id)).toBe(true)
    barrier.release()

    const response = await pending
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_token' })
    expect(userCount(app)).toBe(0)
  })

  it('rejects reset when the account disappears during hashing', async () => {
    const seeded = await seedTestUser(app, 'roberto', 'old-password12')
    const { rawToken } = createInviteRecord(app.db, {
      type: 'password_reset',
      userId: seeded.id,
      expiryHours: 48,
    })
    const barrier = installHashBarrier()

    const pending = app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, password: 'new-password123' },
    })
    await barrier.waitForStarters(1)
    app.db.pragma('foreign_keys = OFF')
    app.db.prepare('DELETE FROM users WHERE id = ?').run(seeded.id)
    app.db.pragma('foreign_keys = ON')
    barrier.release()

    const response = await pending
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_token' })
    expect(lookupInviteByRawToken(app.db, rawToken).valid).toBe(true)
  })
})
