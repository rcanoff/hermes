import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createJobConversation } from '../src/db/repos/conversations.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

interface BotBody {
  id: string
  user_id: string
  slug: string
  name: string
  role: string
  soul: string
  responsibilities: string
  icon: string
  color: string
  runtime: 'hermes' | 'grok'
  notifications_enabled: boolean
  last_message_at: string | null
  last_message: string | null
  is_default: boolean
  created_at: string
}

describe('/bots', () => {
  let app: FastifyInstance | undefined
  let hermesHome: string
  let token: string
  let userId: string

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

  function extraProfileDir(slug: string, username = 'operator') {
    return path.join(hermesHome, 'profiles', `${username}-${slug}`)
  }

  it('GET returns no bots for a new user', async () => {
    const seeded = await seedTestUser(app!, 'empty-user', 'password123', { seedDefaultBot: false })
    const response = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: { authorization: `Bearer ${seeded.token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      bots: BotBody[]
      _links: { self: { href: string } }
    }
    expect(body.bots).toEqual([])
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
      user_id: userId,
      slug: 'travel',
      name: 'Travel',
      role: 'Finds flights, bookings, and tickets.',
      responsibilities: '',
      is_default: false,
      icon: 'message',
      color: 'blue',
      runtime: 'hermes',
      notifications_enabled: true,
      last_message_at: null,
    })
    expect(bot.soul).toContain('Finds flights, bookings, and tickets.')

    const dir = extraProfileDir('travel')
    expect(fs.existsSync(path.join(dir, 'SOUL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toContain(
      'Finds flights, bookings, and tickets.',
    )
    expect(fs.readFileSync(path.join(dir, 'profile.yaml'), 'utf8')).toContain('Travel')
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toContain('test-model')
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain(
      'API_SERVER_KEY=test-gateway-key-32chars-minimum',
    )
    expect(fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink()).toBe(false)
    expect(fs.statSync(path.join(dir, 'skills')).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(hermesHome, 'skills', 'companion-app', 'SKILL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toContain(
      path.join(hermesHome, 'skills'),
    )
  })

  it('GET /bots/:id converts legacy symlink skills to real dir + external_dirs without wiping soul', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    expect(created.statusCode).toBe(201)
    const bot = created.json() as BotBody
    const dir = extraProfileDir('travel')
    const soulPath = path.join(dir, 'SOUL.md')
    const soulBefore = fs.readFileSync(soulPath, 'utf8')
    const skillsPath = path.join(dir, 'skills')
    const configPath = path.join(dir, 'config.yaml')

    fs.rmSync(skillsPath, { recursive: true, force: true })
    fs.symlinkSync(path.join(hermesHome, 'skills'), skillsPath)
    fs.writeFileSync(configPath, 'model:\n  default: test-model\nskills:\n  external_dirs: []\n')
    expect(fs.lstatSync(skillsPath).isSymbolicLink()).toBe(true)

    const got = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(got.statusCode).toBe(200)
    expect(fs.lstatSync(skillsPath).isSymbolicLink()).toBe(false)
    expect(fs.statSync(skillsPath).isDirectory()).toBe(true)
    expect(fs.readFileSync(configPath, 'utf8')).toContain(path.join(hermesHome, 'skills'))
    expect(fs.readFileSync(soulPath, 'utf8')).toBe(soulBefore)
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
    const dir = extraProfileDir('travel')
    expect(fs.existsSync(dir)).toBe(true)

    const response = await app!.inject({
      method: 'DELETE',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(204)
    expect(fs.existsSync(dir)).toBe(false)

    const missing = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(missing.statusCode).toBe(404)
  })

  it('DELETE other with conversations returns 204 and removes the chats', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody

    const chat = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: bot.id },
    })
    expect(chat.statusCode).toBe(201)
    const conversationId = (chat.json() as { id: string }).id

    const response = await app!.inject({
      method: 'DELETE',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(204)

    const missingBot = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(missingBot.statusCode).toBe(404)

    const missingChat = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}`,
      headers: authHeaders(),
    })
    expect(missingChat.statusCode).toBe(404)
  })

  it('last_message_at is null when this user has no regular chats with the bot', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody
    expect(bot.last_message_at).toBeNull()

    const got = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(got.statusCode).toBe(200)
    expect((got.json() as BotBody).last_message_at).toBeNull()

    const listed = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: authHeaders(),
    })
    const listedBot = (listed.json() as { bots: BotBody[] }).bots.find((row) => row.id === bot.id)
    expect(listedBot?.last_message_at).toBeNull()
  })

  it('last_message_at is max regular conversation updated_at for this user', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody

    const older = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: bot.id },
    })
    const newer = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: bot.id },
    })
    expect(older.statusCode).toBe(201)
    expect(newer.statusCode).toBe(201)
    const olderId = (older.json() as { id: string }).id
    const newerId = (newer.json() as { id: string }).id
    const latest = '2026-09-10 12:00:00'
    app!.db.prepare(`UPDATE conversations SET updated_at = '2026-09-01 00:00:00' WHERE id = ?`).run(olderId)
    app!.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(latest, newerId)

    const got = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(got.statusCode).toBe(200)
    expect((got.json() as BotBody).last_message_at).toBe(latest)

    const listed = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: authHeaders(),
    })
    const listedBot = (listed.json() as { bots: BotBody[] }).bots.find((row) => row.id === bot.id)
    expect(listedBot?.last_message_at).toBe(latest)

    const patched = await app!.inject({
      method: 'PATCH',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
      payload: { name: 'Travel bot' },
    })
    expect(patched.statusCode).toBe(200)
    expect((patched.json() as BotBody).last_message_at).toBe(latest)

    const page = await app!.inject({
      method: 'GET',
      url: '/bots?limit=1',
      headers: authHeaders(),
    })
    const pageBody = page.json() as { bots: BotBody[]; _links: { next?: { href: string } } }
    expect(pageBody.bots[0]!.is_default).toBe(true)
    expect(pageBody._links.next?.href).toMatch(/^\/bots\?limit=1&before=/)
  })

  it('last_message_at ignores other users’ chats and job conversations', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody
    const other = await seedTestUser(app!, 'other', 'password123')
    const otherChatId = '11111111-1111-4111-8111-111111111111'
    const otherUpdatedAt = '2026-09-10 15:00:00'
    app!.db
      .prepare(
        `
        INSERT INTO conversations (
          id, user_id, hermes_session_id, kind, bot_id, updated_at
        ) VALUES (?, ?, 'hs-other', 'regular', ?, ?)
      `,
      )
      .run(otherChatId, other.id, bot.id, otherUpdatedAt)

    const jobId = createJobConversation(app!.db, userId, 'operator', { name: 'Digest' })
    app!.db
      .prepare(`UPDATE conversations SET bot_id = ?, updated_at = '2026-09-10 18:00:00' WHERE id = ?`)
      .run(bot.id, jobId)

    const asOwner = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(asOwner.statusCode).toBe(200)
    expect((asOwner.json() as BotBody).last_message_at).toBeNull()

    const asOther = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(asOther.statusCode).toBe(404)
  })

  it('last_message is the latest non-pending regular-chat content for this user', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody
    expect(bot.last_message).toBeNull()

    const older = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: bot.id },
    })
    const newer = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: bot.id },
    })
    const olderId = (older.json() as { id: string }).id
    const newerId = (newer.json() as { id: string }).id
    insertMessage(app!.db, { conversationId: olderId, role: 'user', content: 'old question' })
    insertMessage(app!.db, { conversationId: newerId, role: 'user', content: 'first' })
    insertMessage(app!.db, {
      conversationId: newerId,
      role: 'assistant',
      content: 'latest reply',
    })
    insertMessage(app!.db, {
      conversationId: newerId,
      role: 'assistant',
      content: 'waiting',
      kind: 'pending_input',
    })

    const got = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect((got.json() as BotBody).last_message).toBe('latest reply')

    const listed = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: authHeaders(),
    })
    const listedBot = (listed.json() as { bots: BotBody[] }).bots.find((row) => row.id === bot.id)
    expect(listedBot?.last_message).toBe('latest reply')
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
    for (const icon of ['nope', 'legacy-foo']) {
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

    for (const icon of ['nope', 'legacy-foo']) {
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

    app!.db.prepare('UPDATE bots SET icon = ? WHERE id = ?').run('nope', bot.id)
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
    expect(fs.readFileSync(path.join(extraProfileDir('travel'), 'SOUL.md'), 'utf8')).toBe(
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

  it('POST grok stores sqlite soul only and skips Hermes profile and honcho', async () => {
    const honchoPath = path.join(hermesHome, 'honcho.json')
    fs.writeFileSync(
      honchoPath,
      `${JSON.stringify({ hosts: { 'hermes.default': { aiPeer: 'default' } } }, null, 2)}\n`,
    )
    const honchoBefore = fs.readFileSync(honchoPath, 'utf8')

    const response = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: {
        name: 'Grok',
        role: 'Local Mac agent.',
        runtime: 'grok',
      },
    })

    expect(response.statusCode).toBe(201)
    const bot = response.json() as BotBody
    expect(bot).toMatchObject({
      slug: 'grok',
      name: 'Grok',
      role: 'Local Mac agent.',
      runtime: 'grok',
      is_default: false,
    })
    expect(bot.soul).toContain('Local Mac agent.')
    expect(fs.existsSync(extraProfileDir('grok'))).toBe(false)
    const honchoAfter = JSON.parse(fs.readFileSync(honchoPath, 'utf8')) as {
      hosts: Record<string, unknown>
    }
    expect(honchoAfter.hosts['hermes.default']).toEqual({ aiPeer: 'default' })
    expect(honchoAfter.hosts[`hermes.${userId}.grok`]).toBeUndefined()
    expect(honchoAfter.hosts['hermes.grok']).toBeUndefined()

    const listed = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: authHeaders(),
    })
    const bots = (listed.json() as { bots: BotBody[] }).bots
    expect(bots.find((row) => row.is_default)?.runtime).toBe('hermes')
    expect(bots.find((row) => row.id === bot.id)?.runtime).toBe('grok')
  })

  it('POST second grok returns 409 grok_bot_exists', async () => {
    const first = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Grok', role: 'Mac agent', runtime: 'grok' },
    })
    expect(first.statusCode).toBe(201)

    const second = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Grok Two', role: 'Another Mac agent', runtime: 'grok' },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toEqual({ error: 'grok_bot_exists' })
  })

  it('POST invalid runtime returns 400', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Grok', role: 'Mac agent', runtime: 'acp' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
  })

  it('PATCH runtime is forbidden', async () => {
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
      payload: { runtime: 'grok' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
    expect(
      (
        await app!.inject({
          method: 'GET',
          url: `/bots/${bot.id}`,
          headers: authHeaders(),
        })
      ).json(),
    ).toMatchObject({ id: bot.id, runtime: 'hermes' })
  })

  it('PATCH soul on grok updates sqlite only', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Grok', role: 'Mac agent', runtime: 'grok', soul: 'You are Grok.' },
    })
    const bot = created.json() as BotBody
    expect(bot.soul).toBe('You are Grok.')

    const response = await app!.inject({
      method: 'PATCH',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
      payload: { soul: 'Stay in ~/Companion/grok.' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: bot.id,
      runtime: 'grok',
      soul: 'Stay in ~/Companion/grok.',
    })
    expect(fs.existsSync(extraProfileDir('grok'))).toBe(false)
  })

  it('DELETE grok returns 204 without a profile dir', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Grok', role: 'Mac agent', runtime: 'grok' },
    })
    const bot = created.json() as BotBody

    const response = await app!.inject({
      method: 'DELETE',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(response.statusCode).toBe(204)

    const missing = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(missing.statusCode).toBe(404)
  })

  it('keeps rcanoff default at $HERMES_HOME and namespaces new extras', async () => {
    const rcanoff = await seedTestUser(app!, 'rcanoff', 'password123')
    const listed = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: { authorization: `Bearer ${rcanoff.token}` },
    })
    expect(listed.statusCode).toBe(200)
    expect((listed.json() as { bots: BotBody[] }).bots[0]).toMatchObject({
      user_id: rcanoff.id,
      slug: 'default',
      is_default: true,
    })
    expect(fs.existsSync(path.join(hermesHome, 'profiles', rcanoff.id, 'default'))).toBe(false)

    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: { authorization: `Bearer ${rcanoff.token}` },
      payload: { name: 'Travel', role: 'Flights' },
    })
    expect(created.statusCode).toBe(201)
    expect(fs.existsSync(path.join(hermesHome, 'profiles', 'rcanoff-travel', 'SOUL.md'))).toBe(true)
    expect(fs.existsSync(path.join(hermesHome, 'profiles', rcanoff.id, 'travel'))).toBe(false)
    expect(fs.existsSync(path.join(hermesHome, 'profiles', 'travel'))).toBe(false)
  })

  it('scopes the roster to the JWT user and 404s other users’ bots', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const travel = created.json() as BotBody
    const other = await seedTestUser(app!, 'AlineTusi', 'password123')

    const otherList = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(otherList.statusCode).toBe(200)
    const otherBots = (otherList.json() as { bots: BotBody[] }).bots
    expect(otherBots).toHaveLength(1)
    expect(otherBots[0]).toMatchObject({
      user_id: other.id,
      slug: 'default',
      is_default: true,
    })
    expect(otherBots.find((row) => row.id === travel.id)).toBeUndefined()

    const hidden = await app!.inject({
      method: 'GET',
      url: `/bots/${travel.id}`,
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(hidden.statusCode).toBe(404)

    const patched = await app!.inject({
      method: 'PATCH',
      url: `/bots/${travel.id}`,
      headers: { authorization: `Bearer ${other.token}` },
      payload: { soul: 'stolen' },
    })
    expect(patched.statusCode).toBe(404)

    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/bots/${travel.id}`,
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(deleted.statusCode).toBe(404)
  })

  it('lets two users each have slug default and each a Grok bot', async () => {
    const firstGrok = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Grok', role: 'Mac agent', runtime: 'grok' },
    })
    expect(firstGrok.statusCode).toBe(201)

    const other = await seedTestUser(app!, 'AlineTusi', 'password123')
    const otherDefault = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(otherDefault.statusCode).toBe(200)
    expect((otherDefault.json() as { bots: BotBody[] }).bots[0]?.slug).toBe('default')

    const otherGrok = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: { authorization: `Bearer ${other.token}` },
      payload: { name: 'Grok', role: 'Mac agent', runtime: 'grok' },
    })
    expect(otherGrok.statusCode).toBe(201)
    expect((otherGrok.json() as BotBody).user_id).toBe(other.id)

    const sameUserSecond = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: { authorization: `Bearer ${other.token}` },
      payload: { name: 'Grok Two', role: 'Another Mac agent', runtime: 'grok' },
    })
    expect(sameUserSecond.statusCode).toBe(409)
    expect(sameUserSecond.json()).toEqual({ error: 'grok_bot_exists' })
  })

  it('DELETE bot removes only that user’s conversations', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Travel', role: 'Flights' },
    })
    const bot = created.json() as BotBody
    const ownChat = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: bot.id },
    })
    expect(ownChat.statusCode).toBe(201)
    const ownChatId = (ownChat.json() as { id: string }).id

    const other = await seedTestUser(app!, 'AlineTusi', 'password123')
    const otherChatId = '22222222-2222-4222-8222-222222222222'
    app!.db
      .prepare(
        `
        INSERT INTO conversations (
          id, user_id, hermes_session_id, kind, bot_id, updated_at
        ) VALUES (?, ?, 'hs-aline', 'regular', ?, datetime('now'))
      `,
      )
      .run(otherChatId, other.id, bot.id)

    const response = await app!.inject({
      method: 'DELETE',
      url: `/bots/${bot.id}`,
      headers: authHeaders(),
    })
    expect(response.statusCode).toBe(204)

    const ownMissing = await app!.inject({
      method: 'GET',
      url: `/conversations/${ownChatId}`,
      headers: authHeaders(),
    })
    expect(ownMissing.statusCode).toBe(404)

    const otherStill = app!.db
      .prepare(`SELECT id, bot_id FROM conversations WHERE id = ?`)
      .get(otherChatId) as { id: string; bot_id: string | null }
    expect(otherStill.id).toBe(otherChatId)
    expect(otherStill.bot_id).toBeNull()
  })
})
