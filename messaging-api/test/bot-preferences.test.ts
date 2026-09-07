import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

interface BotBody {
  id: string
  slug: string
  notifications_enabled: boolean
}

describe('bot notification preferences', () => {
  let app: FastifyInstance | undefined
  let hermesHome: string
  let tokenA: string
  let tokenB: string

  beforeEach(async () => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-bot-prefs-'))
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: test-model\n')
    fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-gateway-key-32chars-minimum\n')
    const companionSkillDir = path.join(hermesHome, 'skills', 'companion-app')
    fs.mkdirSync(companionSkillDir, { recursive: true })
    fs.writeFileSync(path.join(companionSkillDir, 'SKILL.md'), '# companion-app\n')
    app = await createTestApp({ hermesHome })
    await app.ready()
    tokenA = (await seedTestUser(app, 'alice', 'password123')).token
    tokenB = (await seedTestUser(app, 'bob', 'password123')).token
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  async function createTravelBot(): Promise<BotBody> {
    const created = await app!.inject({
      method: 'POST',
      url: '/bots',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Travel', role: 'Flights' },
    })
    expect(created.statusCode).toBe(201)
    return created.json() as BotBody
  }

  it('GET hydrates notifications_enabled true when no preference row exists', async () => {
    const bot = await createTravelBot()

    const response = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: bot.id,
      notifications_enabled: true,
    })
  })

  it('PATCH notifications_enabled is per-user', async () => {
    const bot = await createTravelBot()

    const muted = await app!.inject({
      method: 'PATCH',
      url: `/bots/${bot.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { notifications_enabled: false },
    })
    expect(muted.statusCode).toBe(200)
    expect(muted.json()).toMatchObject({ notifications_enabled: false })

    const asA = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(asA.statusCode).toBe(200)
    expect(asA.json()).toMatchObject({ notifications_enabled: false })

    const asB = await app!.inject({
      method: 'GET',
      url: `/bots/${bot.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    })
    expect(asB.statusCode).toBe(200)
    expect(asB.json()).toMatchObject({ notifications_enabled: true })

    const listB = await app!.inject({
      method: 'GET',
      url: '/bots',
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const listed = (listB.json() as { bots: BotBody[] }).bots.find((row) => row.id === bot.id)
    expect(listed?.notifications_enabled).toBe(true)
  })
})
