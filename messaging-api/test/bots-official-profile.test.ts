import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { insertBot } from '../src/db/repos/bots.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('POST /bots official Hermes profiles', () => {
  let app: FastifyInstance | undefined
  let hermesHome: string
  let token: string
  let userId: string

  beforeEach(async () => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-official-bots-'))
    fs.writeFileSync(
      path.join(hermesHome, 'config.yaml'),
      'platforms:\n  api_server:\n    extra:\n      port: 8642\nmodel:\n  default: test-model\n',
    )
    fs.mkdirSync(path.join(hermesHome, 'skills', 'companion-app'), { recursive: true })
    fs.writeFileSync(path.join(hermesHome, 'skills', 'companion-app', 'SKILL.md'), '# companion-app\n')
    app = await createTestApp({ hermesHome })
    await app.ready()
    const seeded = await seedTestUser(app, 'alice', 'password123')
    token = seeded.token
    userId = seeded.id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  function authHeaders() {
    return { authorization: `Bearer ${token}` }
  }

  it('creates alice-travel via dashboard and stores hermes_profile_name', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights', soul: 'You book trips.' },
    })

    expect(created.statusCode).toBe(201)
    const body = created.json() as { slug: string; hermes_profile_name: string | null }
    expect(body.slug).toBe('travel')
    expect(body.hermes_profile_name).toBe('alice-travel')
    expect(fs.existsSync(path.join(hermesHome, 'profiles', 'alice-travel', 'SOUL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(hermesHome, 'profiles', 'alice-travel', 'SOUL.md'), 'utf8')).toBe(
      'You book trips.',
    )
    expect(fs.existsSync(path.join(hermesHome, 'profiles', userId, 'travel'))).toBe(false)
    const cfg = fs.readFileSync(path.join(hermesHome, 'profiles', 'alice-travel', 'config.yaml'), 'utf8')
    expect(cfg).not.toMatch(/api_server/)
  })

  it('does not call dashboard for grok bots', async () => {
    const createProfile = vi.spyOn(app!.hermesDashboard, 'createProfile')

    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Grok', role: 'Mac agent', runtime: 'grok' },
    })

    expect(created.statusCode).toBe(201)
    expect((created.json() as { hermes_profile_name: string | null }).hermes_profile_name).toBeNull()
    expect(createProfile).not.toHaveBeenCalled()
  })

  it('returns 409 hermes_profile_taken when the official profile already exists', async () => {
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'alice-travel'), { recursive: true })

    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })

    expect(created.statusCode).toBe(409)
    expect(created.json()).toEqual({ error: 'hermes_profile_taken' })
  })

  it('rolls back Hermes profile if sqlite insert fails', async () => {
    insertBot(app!.db, {
      userId,
      slug: 'other',
      name: 'Other',
      role: 'Other',
      soul: 'soul',
      hermesProfileName: 'alice-travel',
    })

    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })

    expect(created.statusCode).toBe(500)
    expect(fs.existsSync(path.join(hermesHome, 'profiles', 'alice-travel'))).toBe(false)
  })
})
