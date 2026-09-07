import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiHermesClient } from '../src/services/hermes-client.js'

describe('OpenAiHermesClient companion user header', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards X-Companion-User-Id on streamChat when companionUserId is set', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    const iterator = client.streamChat({
      hermesSessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
      companionUserId: '11111111-1111-4111-8111-111111111111',
    })

    for await (const _event of iterator) {
      // drain
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-companion-user-id']).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('omits X-Companion-User-Id on streamChat when companionUserId is absent', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAiHermesClient('http://hermes:8642', 'test-key')
    const iterator = client.streamChat({
      hermesSessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    })

    for await (const _event of iterator) {
      // drain
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-companion-user-id']).toBeUndefined()
  })
})