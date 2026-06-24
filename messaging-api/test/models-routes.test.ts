import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
  DEFAULT_COMPANION_MODELS,
} from '../src/lib/companion-models.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('GET /models', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/models',
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns curated models and default with auth', async () => {
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

    app = await createTestApp({ companionModels: customCatalog })
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
      default: {
        model: COMPANION_DEFAULT_MODEL,
        provider: COMPANION_DEFAULT_PROVIDER,
      },
    })
  })
})