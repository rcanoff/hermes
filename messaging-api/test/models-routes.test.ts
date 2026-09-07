import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
  DEFAULT_COMPANION_MODELS,
} from '../src/lib/companion-models.js'
import { createConversation, createJobConversation } from '../src/db/repos/conversations.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('GET /models', () => {
  let app: FastifyInstance
  let hermesHome: string

  beforeEach(async () => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-models-'))
    app = await createTestApp({ hermesHome })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/models',
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns curated models, empty recents, and default with auth', async () => {
    await seedTestUser(app, 'operator', 'password123')
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    const { token } = login.json() as { token: string }

    const response = await app.inject({
      method: 'GET',
      url: '/models',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      models: DEFAULT_COMPANION_MODELS,
      recents: [],
      default: {
        model: COMPANION_DEFAULT_MODEL,
        provider: COMPANION_DEFAULT_PROVIDER,
      },
    })
  })

  it('returns operator-configured catalog from app options', async () => {
    const customCatalog = [
      {
        model: 'operator-model',
        provider: 'operator-provider',
        display: 'Operator Model',
      },
    ]
    await app.close()

    app = await createTestApp({ companionModels: customCatalog, hermesHome })
    await app.ready()

    const { token } = await seedTestUser(app, 'operator', 'password123')
    const response = await app.inject({
      method: 'GET',
      url: '/models',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      models: customCatalog,
      recents: [],
      default: {
        model: COMPANION_DEFAULT_MODEL,
        provider: COMPANION_DEFAULT_PROVIDER,
      },
    })
  })

  it('returns recents for the JWT user ordered by conversation updated_at', async () => {
    const operator = await seedTestUser(app, 'operator', 'password123')
    const other = await seedTestUser(app, 'other-user', 'password123')

    const oldest = createConversation(app.db, operator.id, 'hs-old', null, {
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
    })
    const newest = createConversation(app.db, operator.id, 'hs-new', null, {
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })
    const duplicate = createConversation(app.db, operator.id, 'hs-dup', null, {
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
    })
    const otherUser = createConversation(app.db, other.id, 'hs-other', null, {
      model: COMPANION_DEFAULT_MODEL,
      provider: COMPANION_DEFAULT_PROVIDER,
    })
    const jobId = createJobConversation(app.db, operator.id, 'operator', {
      name: 'nightly',
    })
    app.db
      .prepare(`UPDATE conversations SET model = ?, provider = ? WHERE id = ?`)
      .run('job-only-model', 'job-provider', jobId)

    app.db
      .prepare(`UPDATE conversations SET updated_at = datetime('now', '-3 hours') WHERE id = ?`)
      .run(oldest)
    app.db
      .prepare(`UPDATE conversations SET updated_at = datetime('now', '-1 hour') WHERE id = ?`)
      .run(duplicate)
    app.db
      .prepare(`UPDATE conversations SET updated_at = datetime('now', '-2 hours') WHERE id = ?`)
      .run(newest)
    app.db
      .prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`)
      .run(otherUser)
    app.db
      .prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`)
      .run(jobId)

    const response = await app.inject({
      method: 'GET',
      url: '/models',
      headers: { authorization: `Bearer ${operator.token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      recents: [
        {
          model: 'gpt-5.4-mini',
          provider: 'openai-codex',
          display: 'gpt-5.4-mini',
        },
        {
          model: 'grok-4.3',
          provider: 'xai-oauth',
          display: 'grok-4.3',
        },
      ],
    })
  })
})
