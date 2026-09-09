import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { DEFAULT_BOT_RESPONSIBILITIES } from '../src/db/repos/bots.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

interface BotBody {
  id: string
  slug: string
  name: string
  role: string
  soul: string
  responsibilities: string
  icon: string
  color: string
  notifications_enabled: boolean
  is_default: boolean
  created_at: string
}

describe('/bots', () => {
  let app: FastifyInstance | undefined
  let hermesHome: string
  let token: string

  beforeEach(async () => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-bots-'))
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: test-model\n')
    fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-gateway-key-32chars-minimum\n')
    const companionSkillDir = path.join(hermesHome, 'skills', 'companion-app')
    fs.mkdirSync(companionSkillDir, { recursive: true })
    fs.writeFileSync(path.join(companionSkillDir, 'SKILL.md'), '# companion-app\n')
    app = await createTestApp({ hermesHome })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    token = seeded.token
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  function authHeaders() {
    return { authorization: `Bearer ${token}` }
  }

  it('GET seeds the default Hermes bot', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      bots: BotBody[]
      _links: { self: { href: string } }
    }
    expect(body.bots).toHaveLength(1)
    expect(body.bots[0]).toMatchObject({
      slug: 'default',
      name: 'Hermes',
      is_default: true,
      icon: 'message',
      color: 'blue',
      notifications_enabled: true,
      responsibilities: DEFAULT_BOT_RESPONSIBILITIES,
    })
    expect(body._links.self.href).toBe('/bots?limit=20')
  })

  it('POST creates sqlite row and profile dir with SOUL.md containing role', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: {
        name: 'Travel',
        role: 'Finds flights, bookings, and tickets.',
      },
    })

    expect(response.statusCode).toBe(201)
    const bot = response.json() as BotBody
    expect(bot).toMatchObject({
      slug: 'travel',
      name: 'Travel',
      role: 'Finds flights, bookings, and tickets.',
      responsibilities: '',
      is_default: false,
      icon: 'message',
      color: 'blue',
      notifications_enabled: true,
    })
    expect(bot.soul).toContain('Finds flights, bookings, and tickets.')

    const profileDir = path.join(hermesHome, 'profiles', 'travel')
    expect(fs.existsSync(path.join(profileDir, 'SOUL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(profileDir, 'SOUL.md'), 'utf8')).toContain(
      'Finds flights, bookings, and tickets.',
    )
    expect(fs.readFileSync(path.join(profileDir, 'profile.yaml'), 'utf8')).toContain('Travel')
    expect(fs.readFileSync(path.join(profileDir, 'config.yaml'), 'utf8')).toContain('test-model')
    expect(fs.readFileSync(path.join(profileDir, '.env'), 'utf8')).toContain(
      'API_SERVER_KEY=test-gateway-key-32chars-minimum',
    )
    expect(fs.lstatSync(path.join(profileDir, 'skills')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(profileDir, 'skills', 'companion-app', 'SKILL.md'))).toBe(true)
  })

  it('POST returns 409 slug_taken for a duplicate name slug', async () => {
    const first = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    expect(first.statusCode).toBe(201)

    const second = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Hotels' },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toEqual({ error: 'slug_taken' })
  })

  it('DELETE default returns 409 default_bot', async () => {
    const list = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: authHeaders(),
    })
    const defaultId = (list.json() as { bots: BotBody[] }).bots[0]!.id

    const response = await app!.inject({
      method: 'DELETE',
      url: `/bots/${defaultId}`,
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'default_bot' })
  })

  it('DELETE other returns 204 and removes the profile dir', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody
    const profileDir = path.join(hermesHome, 'profiles', 'travel')
    expect(fs.existsSync(profileDir)).toBe(true)

    const response = await app!.inject({
      method: 'DELETE',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(204)
    expect(fs.existsSync(profileDir)).toBe(false)

    const missing = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(missing.statusCode).toBe(404)
  })

  it('lists with HAL next when there is another page', async () => {
    await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })

    const response = await app!.inject({
      method: 'GET',
      url: '/bots?limit=1',
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      bots: BotBody[]
      _links: { self: { href: string }; next?: { href: string } }
    }
    expect(body.bots).toHaveLength(1)
    expect(body.bots[0]!.is_default).toBe(true)
    expect(body._links.self.href).toBe('/bots?limit=1')
    expect(body._links.next?.href).toMatch(/^\/bots\?limit=1&before=/)
  })

  it('returns 401 without JWT', async () => {
    const response = await app!.inject({ method: 'GET', url: '/bots' })
    expect(response.statusCode).toBe(401)
  })

  it('POST with invalid or retired icon returns 400 invalid_request', async () => {
    for (const icon of ['nope', 'person', 'briefcase']) {
      const response = await app!.inject({
        method: 'POST',
        url: '/bots',
        headers: authHeaders(),
        payload: { name: 'Travel', role: 'Flights', icon },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'invalid_request' })
    }
  })

  it('POST with icon and color persists them', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: {
        name: 'Travel',
        role: 'Flights',
        icon: 'map',
        color: 'teal',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      slug: 'travel',
      icon: 'map',
      color: 'teal',
    })
  })

  it('PATCH invalid or retired icon returns 400 invalid_request', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody

    for (const icon of ['nope', 'person', 'heart']) {
      const response = await app!.inject({
        method: 'PATCH',
        url: `/bots/${bot.id}`,
        headers: authHeaders(),
        payload: { icon },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'invalid_request' })
    }
  })

  it('PATCH icon and color updates appearance', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody

    const response = await app!.inject({
      method: 'PATCH',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
      payload: { icon: 'bolt', color: 'orange' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: bot.id,
      icon: 'bolt',
      color: 'orange',
    })
  })

  it('GET maps retired icons to message and keeps allowlisted icons', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody

    app!.db.prepare('UPDATE bots SET icon = ? WHERE id = ?').run('person', bot.id)
    const retired = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(retired.statusCode).toBe(200)
    expect(retired.json()).toMatchObject({ id: bot.id, icon: 'message' })

    const listed = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: authHeaders(),
    })
    const listedBot = (listed.json() as { bots: BotBody[] }).bots.find((row) => row.id === bot.id)
    expect(listedBot?.icon).toBe('message')

    app!.db.prepare('UPDATE bots SET icon = ? WHERE id = ?').run('brain', bot.id)
    const kept = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(kept.json()).toMatchObject({ id: bot.id, icon: 'brain' })
  })

  it('PATCH writes SOUL.md for a non-default bot', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody

    const response = await app!.inject({
      method: 'PATCH',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
      payload: { soul: 'You book trips and never invent prices.' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: bot.id,
      slug: 'travel',
      soul: 'You book trips and never invent prices.',
    })
    expect(fs.readFileSync(path.join(hermesHome, 'profiles', 'travel', 'SOUL.md'), 'utf8')).toBe(
      'You book trips and never invent prices.',
    )
  })

  it('PATCH responsibilities stores the jobs line without rewriting soul', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody
    expect(bot.responsibilities).toBe('')

    const response = await app!.inject({
      method: 'PATCH',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
      payload: { responsibilities: 'Flights, bookings, and tickets.' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: bot.id,
      soul: bot.soul,
      responsibilities: 'Flights, bookings, and tickets.',
    })
  })

  it('PATCH empty or overlong responsibilities returns 400', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody

    const empty = await app!.inject({
      method: 'PATCH',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
      payload: { responsibilities: '   ' },
    })
    expect(empty.statusCode).toBe(400)

    const tooLong = await app!.inject({
      method: 'PATCH',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
      payload: { responsibilities: 'x'.repeat(201) },
    })
    expect(tooLong.statusCode).toBe(400)
  })
})
