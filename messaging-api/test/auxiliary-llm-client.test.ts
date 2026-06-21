import { describe, expect, it } from 'vitest'
import {
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