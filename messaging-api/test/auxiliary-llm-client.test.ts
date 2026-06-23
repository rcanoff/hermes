import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  completeAuxiliaryLlm,
  DEFAULT_TITLE_GENERATION_MODEL,
  resolveChatCompletionsUrl,
} from '../src/services/auxiliary-llm-client.js'

describe('resolveChatCompletionsUrl', () => {
  it('defaults to the OpenAI v1 chat completions endpoint', () => {
    expect(resolveChatCompletionsUrl('')).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('appends chat/completions to a /v1 base URL', () => {
    expect(resolveChatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  it('preserves a fully qualified chat completions URL', () => {
    expect(resolveChatCompletionsUrl('https://proxy.example/v1/chat/completions')).toBe(
      'https://proxy.example/v1/chat/completions',
    )
  })
})

describe('DEFAULT_TITLE_GENERATION_MODEL', () => {
  it('uses the fast nano model configured for Hermes auxiliary title generation', () => {
    expect(DEFAULT_TITLE_GENERATION_MODEL).toBe('gpt-5.4-nano')
  })
})

describe('completeAuxiliaryLlm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses max_completion_tokens for newer OpenAI chat models', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.max_completion_tokens).toBe(64)
      expect(body.max_tokens).toBeUndefined()

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Where am I' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const title = await completeAuxiliaryLlm(
      {
        apiKey: 'test-key',
        baseUrl: '',
        model: 'gpt-5.4-nano',
        timeoutMs: 5_000,
      },
      [{ role: 'user', content: 'Where am I?' }],
    )

    expect(title).toBe('Where am I')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})