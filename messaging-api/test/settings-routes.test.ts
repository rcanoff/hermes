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
import { hermesConfigPath } from '../src/lib/hermes-default-model.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('GET/PATCH /settings', () => {
  let app: FastifyInstance
  let hermesHome: string
  let token: string

  beforeEach(async () => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-settings-'))
    app = await createTestApp({ hermesHome })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    token = seeded.token
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/settings' })
    expect(response.statusCode).toBe(401)
  })

  it('seeds default_model from Hermes yaml when unset', async () => {
    fs.writeFileSync(
      hermesConfigPath(hermesHome),
      [
        'model:',
        '  default: grok-4.5',
        '  provider: xai-oauth',
        '  base_url: https://api.x.ai/v1',
        'fallback_providers: []',
        '',
      ].join('\n'),
    )

    const response = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      default_model: {
        model: 'grok-4.5',
        provider: 'xai-oauth',
        display: 'grok-4.5',
      },
    })

    const models = await app.inject({
      method: 'GET',
      url: '/models',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(models.json()).toMatchObject({
      default: { model: 'grok-4.5', provider: 'xai-oauth' },
      recents: [],
    })
  })

  it('falls back to companion constants when yaml is missing', async () => {
    const catalogDefault = DEFAULT_COMPANION_MODELS.find(
      (entry) =>
        entry.model === COMPANION_DEFAULT_MODEL &&
        entry.provider === COMPANION_DEFAULT_PROVIDER,
    )

    const response = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      default_model: catalogDefault,
    })
  })

  it('PATCH updates GET /models.default and yaml keys without rewriting the rest', async () => {
    fs.writeFileSync(
      hermesConfigPath(hermesHome),
      [
        'model:',
        '  default: grok-4.5',
        '  provider: xai-oauth',
        '  base_url: https://api.x.ai/v1',
        'fallback_providers: []',
        '',
      ].join('\n'),
    )

    const patch = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        default_model: { model: 'grok-4.3', provider: 'xai-oauth' },
      },
    })

    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toEqual({
      default_model: DEFAULT_COMPANION_MODELS.find(
        (entry) => entry.model === 'grok-4.3' && entry.provider === 'xai-oauth',
      ),
    })

    const settings = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(settings.json()).toEqual(patch.json())

    const models = await app.inject({
      method: 'GET',
      url: '/models',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(models.statusCode).toBe(200)
    expect(models.json()).toMatchObject({
      default: { model: 'grok-4.3', provider: 'xai-oauth' },
    })

    expect(fs.readFileSync(hermesConfigPath(hermesHome), 'utf8')).toBe(
      [
        'model:',
        '  default: grok-4.3',
        '  provider: xai-oauth',
        '  base_url: https://api.x.ai/v1',
        'fallback_providers: []',
        '',
      ].join('\n'),
    )
  })

  it('rejects unknown models with 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        default_model: { model: 'unknown', provider: 'xai-oauth' },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
  })

  it('uses the stored default for new conversations without an explicit model', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        default_model: { model: 'gpt-5.4-mini', provider: 'openai-codex' },
      },
    })
    expect(patch.statusCode).toBe(200)

    const create = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(create.statusCode).toBe(201)
    expect(create.json()).toMatchObject({
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
      model_display: 'gpt-5.4-mini',
    })
  })
})
