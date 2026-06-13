import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { getLocationEventById } from '../src/db/repos/location-events.js'
import type { CompleteChatInput } from '../src/services/hermes-client.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { createTestApp } from './helpers/app.js'

class GeocodeFakeHermesClient extends FakeHermesClient {
  readonly completeRequests: CompleteChatInput[] = []
  private readonly response: string | Error

  constructor(response: string | Error) {
    super()
    this.response = response
  }

  async completeChat(input: CompleteChatInput): Promise<string> {
    this.completeRequests.push(input)
    if (this.response instanceof Error) {
      throw this.response
    }
    return this.response
  }
}

describe('AddressEnrichmentQueue', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string

  beforeEach(async () => {
    const hermesClient = new GeocodeFakeHermesClient('Rua Example 1, Lisbon')
    app = await createTestApp({
      hermesClient,
      addressEnrichmentSessionId: 'companion-address-enrichment',
    })
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    operatorToken = (login.json() as { token: string }).token
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('resolves pending events via Hermes reverse geocoding', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        lat: 38.7223,
        lon: -9.1393,
        accuracy_m: 12,
        timestamp: '2026-06-13T09:00:00.000Z',
        trigger: 'manual',
        source: 'ios',
      },
    })

    expect(response.statusCode).toBe(204)

    const pending = app!.db
      .prepare('SELECT id FROM location_events WHERE address_status = ?')
      .get('pending') as { id: string }

    await new Promise((resolve) => setTimeout(resolve, 50))

    const updated = getLocationEventById(app!.db, pending.id)
    expect(updated).toMatchObject({
      address: 'Rua Example 1, Lisbon',
      address_source: 'server',
      address_status: 'resolved',
    })

    const hermesClient = app!.hermesClient as GeocodeFakeHermesClient
    expect(hermesClient.completeRequests).toHaveLength(1)
    expect(hermesClient.completeRequests[0]).toMatchObject({
      hermesSessionId: 'companion-address-enrichment',
      messages: [
        {
          role: 'user',
          content: 'Return only a single-line postal address for lat 38.7223 lon -9.1393. No other text.',
        },
      ],
    })
  })

  it('marks pending events failed when reverse geocoding fails', async () => {
    const failingClient = new GeocodeFakeHermesClient(new Error('Hermes unavailable'))
    await app!.close()

    app = await createTestApp({
      hermesClient: failingClient,
      addressEnrichmentSessionId: 'companion-address-enrichment',
    })
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    operatorToken = (login.json() as { token: string }).token

    await app.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        lat: 40.4168,
        lon: -3.7038,
        accuracy_m: 10,
        timestamp: '2026-06-13T10:00:00.000Z',
        trigger: 'manual',
        source: 'ios',
      },
    })

    const pending = app.db
      .prepare('SELECT id FROM location_events WHERE address_status = ?')
      .get('pending') as { id: string }

    await new Promise((resolve) => setTimeout(resolve, 50))

    const updated = getLocationEventById(app.db, pending.id)
    expect(updated).toMatchObject({
      address: '',
      address_source: 'server',
      address_status: 'failed',
    })
  })
})