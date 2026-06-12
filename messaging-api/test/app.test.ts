import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'

describe('buildApp', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('serves the health endpoint', async () => {
    app = await createTestApp()

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })
})
