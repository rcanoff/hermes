import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HermesDashboardClient,
  HermesDashboardError,
} from '../src/lib/hermes-dashboard.js'

describe('HermesDashboardClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('creates a profile after password login', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.endsWith('/auth/password-login')) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'set-cookie': 'session=abc; Path=/' },
          })
        }
        if (url.endsWith('/api/profiles') && init?.method === 'POST') {
          expect(init.headers).toEqual(
            expect.objectContaining({ cookie: expect.stringContaining('session=abc') }),
          )
          const body = JSON.parse(String(init.body))
          expect(body).toMatchObject({
            name: 'alice-travel',
            description: 'Travel',
            clone_from: 'default',
            clone_from_default: false,
            clone_all: false,
            clone_channels: false,
            no_skills: false,
          })
          return new Response(
            JSON.stringify({ ok: true, name: 'alice-travel', path: '/profiles/alice-travel' }),
            { status: 200 },
          )
        }
        throw new Error(url)
      },
    )
    const client = new HermesDashboardClient({
      baseUrl: 'http://hermes-gateway:9119',
      username: 'hermes',
      password: 'secret',
    })
    const created = await client.createProfile({
      name: 'alice-travel',
      description: 'Travel',
    })
    expect(created.name).toBe('alice-travel')
    expect(calls[0]).toContain('/auth/password-login')
  })

  it('logs in with basic provider credentials', async () => {
    let loginBody: unknown
    installFetch(async (url, init) => {
      if (url.endsWith('/auth/password-login')) {
        loginBody = JSON.parse(String(init?.body))
        return loginResponse()
      }
      return jsonResponse({ ok: true, name: 'alice-travel' })
    })

    const client = testClient()
    await client.createProfile({ name: 'alice-travel', description: 'Travel' })
    expect(loginBody).toEqual({
      provider: 'basic',
      username: 'hermes',
      password: 'secret',
    })
  })

  it('reuses the session cookie without logging in again', async () => {
    const methods: string[] = []
    installFetch(async (url, init) => {
      methods.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      if (url.endsWith('/api/profiles') && init?.method === 'POST') {
        return jsonResponse({ ok: true, name: 'alice-travel', path: '/profiles/alice-travel' })
      }
      if (url.endsWith('/api/profiles/alice-travel')) {
        return jsonResponse({ name: 'alice-travel' })
      }
      throw new Error(url)
    })

    const client = testClient()
    await client.createProfile({ name: 'alice-travel', description: 'Travel' })
    await client.getProfile('alice-travel')

    expect(methods.filter((call) => call.includes('/auth/password-login'))).toHaveLength(1)
    expect(methods.filter((call) => call.startsWith('GET '))).toHaveLength(1)
  })

  it('deleteProfile treats 404 as missing', async () => {
    installFetch(async (url, init) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      if (url.endsWith('/api/profiles/alice-travel') && init?.method === 'DELETE') {
        return new Response('', { status: 404 })
      }
      throw new Error(url)
    })

    const result = await testClient().deleteProfile('alice-travel')
    expect(result).toEqual({ ok: true, missing: true })
  })

  it('deleteProfile returns ok on 200', async () => {
    installFetch(async (url, init) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      if (url.endsWith('/api/profiles/alice-travel') && init?.method === 'DELETE') {
        return jsonResponse({ ok: true })
      }
      throw new Error(url)
    })

    const result = await testClient().deleteProfile('alice-travel')
    expect(result).toEqual({ ok: true })
  })

  it('deleteProfile treats 409 settlement_pending as success', async () => {
    installFetch(async (url, init) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      if (url.endsWith('/api/profiles/alice-travel') && init?.method === 'DELETE') {
        return jsonResponse({ error: 'settlement_pending' }, 409)
      }
      throw new Error(url)
    })

    const result = await testClient().deleteProfile('alice-travel')
    expect(result).toEqual({ ok: true, settlementPending: true })
  })

  it('getProfile returns the profile on 200', async () => {
    installFetch(async (url, init) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      if (url.endsWith('/api/profiles/alice-travel') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ name: 'alice-travel' })
      }
      throw new Error(url)
    })

    await expect(testClient().getProfile('alice-travel')).resolves.toEqual({ name: 'alice-travel' })
  })

  it('getProfile returns null on 404', async () => {
    installFetch(async (url, init) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      if (url.endsWith('/api/profiles/missing') && (init?.method ?? 'GET') === 'GET') {
        return new Response('', { status: 404 })
      }
      throw new Error(url)
    })

    await expect(testClient().getProfile('missing')).resolves.toBeNull()
  })

  it('maps dashboard 409 exists to hermes_profile_taken', async () => {
    installFetch(async (url) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      return jsonResponse({ error: 'profile exists' }, 409)
    })

    const error = await testClient()
      .createProfile({ name: 'alice-travel', description: 'Travel' })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(HermesDashboardError)
    expect(error).toMatchObject({ status: 409, code: 'hermes_profile_taken' })
  })

  it('maps dashboard 400 exists to hermes_profile_taken', async () => {
    installFetch(async (url) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      return jsonResponse({ error: 'exists' }, 400)
    })

    const error = await testClient()
      .createProfile({ name: 'alice-travel', description: 'Travel' })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(HermesDashboardError)
    expect(error).toMatchObject({ status: 400, code: 'hermes_profile_taken' })
  })

  it('maps other 400 responses to invalid_request', async () => {
    installFetch(async (url) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      return jsonResponse({ error: 'invalid name' }, 400)
    })

    const error = await testClient()
      .createProfile({ name: 'bad', description: 'Travel' })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(HermesDashboardError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' })
  })

  it('maps 5xx responses to unavailable', async () => {
    installFetch(async (url) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      return new Response('gateway down', { status: 502 })
    })

    const error = await testClient()
      .createProfile({ name: 'alice-travel', description: 'Travel' })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(HermesDashboardError)
    expect(error).toMatchObject({ status: 502, code: 'unavailable' })
  })

  it('uses a 10s timeout for create and 15s for delete', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    installFetch(async (url, init) => {
      if (url.endsWith('/auth/password-login')) {
        return loginResponse()
      }
      if (init?.method === 'POST') {
        return jsonResponse({ ok: true, name: 'alice-travel' })
      }
      if (init?.method === 'DELETE') {
        return jsonResponse({ ok: true })
      }
      throw new Error(url)
    })

    const client = testClient()
    await client.createProfile({ name: 'alice-travel', description: 'Travel' })
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)

    timeoutSpy.mockClear()
    await client.deleteProfile('alice-travel')
    expect(timeoutSpy).toHaveBeenCalledWith(15_000)
  })
})

function testClient(): HermesDashboardClient {
  return new HermesDashboardClient({
    baseUrl: 'http://hermes-gateway:9119',
    username: 'hermes',
    password: 'secret',
  })
}

function loginResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'set-cookie': 'session=abc; Path=/' },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith('/auth/password-login')) {
        expect(init?.headers).toEqual(
          expect.objectContaining({ cookie: expect.stringContaining('session=abc') }),
        )
      }
      return handler(url, init)
    },
  )
}
