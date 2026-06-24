import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeHermesAuxiliary } from '../src/services/hermes-auxiliary-client.js'

describe('completeHermesAuxiliary', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts to the bridge and returns content', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://bridge.test:8750/v1/complete')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({
        'content-type': 'application/json',
        authorization: 'Bearer bridge-key',
      })

      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({
        provider: 'xai-oauth',
        model: 'grok-4.3',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        temperature: 0.3,
        timeout: 30,
      })

      return new Response(JSON.stringify({ content: 'Greeting' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const title = await completeHermesAuxiliary('http://bridge.test:8750/', 'bridge-key', {
      provider: 'xai-oauth',
      model: 'grok-4.3',
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 30_000,
    })

    expect(title).toBe('Greeting')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('throws when the bridge returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream error', { status: 502 })),
    )

    await expect(
      completeHermesAuxiliary('http://bridge.test:8750', 'bridge-key', {
        provider: 'openai-codex',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('Hermes auxiliary bridge failed with status 502')
  })
})