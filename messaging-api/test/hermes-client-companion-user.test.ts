import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPANION_APP_SESSION_KEY,
  OpenAiHermesClient,
  companionAppSessionKey,
} from '../src/services/hermes-client.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const USERNAME = 'rcanoff'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseDoneResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200 },
  )
}

function headersOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return init.headers as Record<string, string>
}

describe('companionAppSessionKey', () => {
  it('appends the user id when present', () => {
    expect(companionAppSessionKey(USER_ID)).toBe(`companion-app:${USER_ID}`)
  })

  it('stays companion-app when no user is present', () => {
    expect(companionAppSessionKey()).toBe(COMPANION_APP_SESSION_KEY)
    expect(companionAppSessionKey('  ')).toBe(COMPANION_APP_SESSION_KEY)
  })
})

describe('OpenAiHermesClient companion identity headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards session key and both Companion headers on streamChat when the user is set', async () => {
    const fetchMock = vi.fn(async () => sseDoneResponse())
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    const iterator = client.streamChat({
      hermesSessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
      companionUserId: USER_ID,
      companionUsername: USERNAME,
    })

    for await (const _event of iterator) {
      // drain
    }

    const headers = headersOf(fetchMock)
    expect(headers['x-hermes-session-key']).toBe(`companion-app:${USER_ID}`)
    expect(headers['x-companion-user-id']).toBe(USER_ID)
    expect(headers['x-companion-username']).toBe(USERNAME)
  })

  it('omits Companion headers and uses companion-app on streamChat when the user is absent', async () => {
    const fetchMock = vi.fn(async () => sseDoneResponse())
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    const iterator = client.streamChat({
      hermesSessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    })

    for await (const _event of iterator) {
      // drain
    }

    const headers = headersOf(fetchMock)
    expect(headers['x-hermes-session-key']).toBe(COMPANION_APP_SESSION_KEY)
    expect(headers['x-companion-user-id']).toBeUndefined()
    expect(headers['x-companion-username']).toBeUndefined()
  })

  it('forwards session key and both Companion headers on completeChat when the user is set', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    await client.completeChat({
      hermesSessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
      companionUserId: USER_ID,
      companionUsername: USERNAME,
    })

    const headers = headersOf(fetchMock)
    expect(headers['x-hermes-session-key']).toBe(`companion-app:${USER_ID}`)
    expect(headers['x-companion-user-id']).toBe(USER_ID)
    expect(headers['x-companion-username']).toBe(USERNAME)
  })

  it('omits Companion headers on completeChat when the user is absent', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    await client.completeChat({
      hermesSessionId: 'companion-title-generation:c1',
      messages: [{ role: 'user', content: 'title' }],
    })

    const headers = headersOf(fetchMock)
    expect(headers['x-hermes-session-key']).toBe(COMPANION_APP_SESSION_KEY)
    expect(headers['x-companion-user-id']).toBeUndefined()
    expect(headers['x-companion-username']).toBeUndefined()
  })

  it('sends the conversation model and provider instead of the hermes-agent alias', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    await client.completeChat({
      hermesSessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'grok-4.3',
      provider: 'xai-oauth',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    })
  })

  it('forwards session key and both Companion headers on ensureSession when the user is set', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    await client.ensureSession({
      hermesSessionId: 'sess-1',
      companionUserId: USER_ID,
      companionUsername: USERNAME,
    })

    const headers = headersOf(fetchMock)
    expect(headers['x-hermes-session-key']).toBe(`companion-app:${USER_ID}`)
    expect(headers['x-companion-user-id']).toBe(USER_ID)
    expect(headers['x-companion-username']).toBe(USERNAME)
    expect(headers['x-hermes-session-id']).toBeUndefined()
  })

  it('uses companion-app and omits Companion headers on ensureSession when the user is absent', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    await client.ensureSession({
      hermesSessionId: 'sess-1',
    })

    const headers = headersOf(fetchMock)
    expect(headers['x-hermes-session-key']).toBe(COMPANION_APP_SESSION_KEY)
    expect(headers['x-companion-user-id']).toBeUndefined()
    expect(headers['x-companion-username']).toBeUndefined()
  })
})
