import { afterEach, describe, expect, it, vi } from 'vitest'
import * as auxiliaryLlmClient from '../src/services/auxiliary-llm-client.js'
import { COMPANION_TITLE_GENERATION_SESSION_KEY } from '../src/services/hermes-client.js'
import {
  buildTitlePromptMessages,
  generateConversationTitle,
  isLikelyOpenAiChatModel,
  sanitizeGeneratedTitle,
  shouldPreferHermesTitleGeneration,
} from '../src/services/title-generator.js'
import { FakeHermesClient } from './helpers/hermes.js'

describe('sanitizeGeneratedTitle', () => {
  it('trims whitespace and strips wrapping quotes', () => {
    expect(sanitizeGeneratedTitle('  "Grocery list"  ')).toBe('Grocery list')
  })

  it('removes newlines and caps length at 80 characters', () => {
    const long = 'a'.repeat(100)
    expect(sanitizeGeneratedTitle(long)).toHaveLength(80)
    expect(sanitizeGeneratedTitle('Line one\nLine two')).toBe('Line one Line two')
  })

  it('returns null for empty results', () => {
    expect(sanitizeGeneratedTitle('   ')).toBeNull()
    expect(sanitizeGeneratedTitle('""')).toBeNull()
  })
})

describe('buildTitlePromptMessages', () => {
  it('includes a system instruction and truncated user message', () => {
    const messages = buildTitlePromptMessages('What is the weather in Lisbon?')
    expect(messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining('max 6 words'),
      },
      {
        role: 'user',
        content: 'What is the weather in Lisbon?',
      },
    ])
  })

  it('truncates very long user messages to 500 characters', () => {
    const long = 'x'.repeat(600)
    const messages = buildTitlePromptMessages(long)
    expect(messages[1]?.content).toHaveLength(500)
  })
})

describe('isLikelyOpenAiChatModel', () => {
  it('recognizes common OpenAI chat model names', () => {
    expect(isLikelyOpenAiChatModel('gpt-5.4-nano')).toBe(true)
    expect(isLikelyOpenAiChatModel('chatgpt-4o-latest')).toBe(true)
    expect(isLikelyOpenAiChatModel('o3-mini')).toBe(true)
  })

  it('rejects non-OpenAI model names', () => {
    expect(isLikelyOpenAiChatModel('grok-composer-2.5-fast')).toBe(false)
    expect(isLikelyOpenAiChatModel('claude-3-5-sonnet')).toBe(false)
  })
})

describe('shouldPreferHermesTitleGeneration', () => {
  it('prefers Hermes when auxiliary LLM is not configured', () => {
    expect(shouldPreferHermesTitleGeneration(null)).toBe(true)
    expect(shouldPreferHermesTitleGeneration({ apiKey: '', baseUrl: '', model: 'gpt-4', timeoutMs: 1000 })).toBe(
      true,
    )
  })

  it('prefers Hermes when base URL is empty and model is not OpenAI', () => {
    expect(
      shouldPreferHermesTitleGeneration({
        apiKey: 'key',
        baseUrl: '',
        model: 'grok-composer-2.5-fast',
        timeoutMs: 1000,
      }),
    ).toBe(true)
  })

  it('prefers auxiliary LLM when base URL is set or model is OpenAI', () => {
    expect(
      shouldPreferHermesTitleGeneration({
        apiKey: 'key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'grok-composer-2.5-fast',
        timeoutMs: 1000,
      }),
    ).toBe(false)
    expect(
      shouldPreferHermesTitleGeneration({
        apiKey: 'key',
        baseUrl: '',
        model: 'gpt-5.4-nano',
        timeoutMs: 1000,
      }),
    ).toBe(false)
  })
})

describe('generateConversationTitle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses completeChat with the stable title-generation session key when auxiliary LLM is not configured', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Grocery list')

    const title = await generateConversationTitle(hermesClient, 'Add milk and eggs')

    expect(title).toBe('Grocery list')
    expect(hermesClient.completeRequests).toEqual([
      {
        hermesSessionId: COMPANION_TITLE_GENERATION_SESSION_KEY,
        messages: buildTitlePromptMessages('Add milk and eggs'),
      },
    ])
    expect(hermesClient.requests).toHaveLength(0)
  })

  it('prefers Hermes when auxiliary model is non-OpenAI and base URL is empty', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Hello there')
    const auxiliarySpy = vi.spyOn(auxiliaryLlmClient, 'completeAuxiliaryLlm')

    const title = await generateConversationTitle(hermesClient, 'hello', {
      apiKey: 'test-key',
      baseUrl: '',
      model: 'grok-composer-2.5-fast',
      timeoutMs: 5_000,
    })

    expect(title).toBe('Hello there')
    expect(auxiliarySpy).not.toHaveBeenCalled()
    expect(hermesClient.completeRequests).toHaveLength(1)
  })

  it('falls back to Hermes when auxiliary LLM fails', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Hello there')
    vi.spyOn(auxiliaryLlmClient, 'completeAuxiliaryLlm').mockRejectedValue(
      new Error('Auxiliary LLM request failed with status 404'),
    )
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    const title = await generateConversationTitle(
      hermesClient,
      'hello',
      {
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-nano',
        timeoutMs: 5_000,
      },
      log,
    )

    expect(title).toBe('Hello there')
    expect(hermesClient.completeRequests).toEqual([
      {
        hermesSessionId: COMPANION_TITLE_GENERATION_SESSION_KEY,
        messages: buildTitlePromptMessages('hello'),
      },
    ])
    expect(warnings).toEqual([
      {
        message: 'auxiliary title generation failed; falling back to Hermes',
        meta: {
          model: 'gpt-5.4-nano',
          err: 'Auxiliary LLM request failed with status 404',
        },
      },
    ])
  })

  it('falls back to Hermes when auxiliary LLM returns an empty title', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Morning greeting')
    vi.spyOn(auxiliaryLlmClient, 'completeAuxiliaryLlm').mockResolvedValue('   ')
    const warnings: string[] = []
    const log = (message: string) => {
      warnings.push(message)
    }

    const title = await generateConversationTitle(
      hermesClient,
      'good morning',
      {
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-nano',
        timeoutMs: 5_000,
      },
      log,
    )

    expect(title).toBe('Morning greeting')
    expect(warnings).toContain(
      'auxiliary title generation returned empty result; falling back to Hermes',
    )
  })
})