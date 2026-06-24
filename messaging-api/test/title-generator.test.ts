import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConversation } from '../src/db/repos/conversations.js'
import { initSchema } from '../src/db/schema.js'
import * as auxiliaryLlmClient from '../src/services/auxiliary-llm-client.js'
import { buildTitleGenerationSessionKey } from '../src/services/hermes-client.js'
import {
  buildTitlePromptMessages,
  generateAndSaveTitle,
  generateConversationTitle,
  isLikelyOpenAiChatModel,
  sanitizeGeneratedTitle,
  shouldPreferHermesTitleGeneration,
} from '../src/services/title-generator.js'
import { StreamHub } from '../src/streams/hub.js'
import { FakeHermesClient } from './helpers/hermes.js'

describe('sanitizeGeneratedTitle', () => {
  it('trims whitespace and strips wrapping quotes', () => {
    expect(sanitizeGeneratedTitle('  "Grocery list"  ')).toBe('Grocery list')
  })

  it('caps length at 80 characters', () => {
    const long = 'a'.repeat(100)
    expect(sanitizeGeneratedTitle(long)).toHaveLength(80)
  })

  it('returns null for empty results', () => {
    expect(sanitizeGeneratedTitle('   ')).toBeNull()
    expect(sanitizeGeneratedTitle('""')).toBeNull()
  })

  it('rejects titles containing markdown fences', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    expect(
      sanitizeGeneratedTitle("You're at Simon-Dach-Straße 10 ```map ty", log),
    ).toBeNull()
    expect(warnings).toEqual([
      {
        message: 'title generation rejected invalid title',
        meta: { reason: 'markdown_fence' },
      },
    ])
  })

  it('rejects titles containing newlines', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    expect(sanitizeGeneratedTitle('Line one\nLine two', log)).toBeNull()
    expect(warnings).toEqual([
      {
        message: 'title generation rejected invalid title',
        meta: { reason: 'newline' },
      },
    ])
  })

  it('rejects titles with more than 10 words', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    const tooLong = 'one two three four five six seven eight nine ten eleven'
    expect(sanitizeGeneratedTitle(tooLong, log)).toBeNull()
    expect(warnings).toEqual([
      {
        message: 'title generation rejected invalid title',
        meta: { reason: 'too_many_words', wordCount: 11 },
      },
    ])
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
  const conversationId = 'd899b6f6-283b-4632-bbc3-175b0ebfd1fb'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses completeChat with a per-conversation title-generation session key when auxiliary LLM is not configured', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Grocery list')

    const title = await generateConversationTitle(hermesClient, conversationId, 'Add milk and eggs')

    expect(title).toBe('Grocery list')
    expect(hermesClient.completeRequests).toEqual([
      {
        hermesSessionId: buildTitleGenerationSessionKey(conversationId),
        messages: buildTitlePromptMessages('Add milk and eggs'),
      },
    ])
    expect(hermesClient.requests).toHaveLength(0)
  })

  it('prefers Hermes when auxiliary model is non-OpenAI and base URL is empty', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Hello there')
    const auxiliarySpy = vi.spyOn(auxiliaryLlmClient, 'completeAuxiliaryLlm')

    const title = await generateConversationTitle(hermesClient, conversationId, 'hello', {
      apiKey: 'test-key',
      baseUrl: '',
      model: 'grok-composer-2.5-fast',
      timeoutMs: 5_000,
    })

    expect(title).toBe('Hello there')
    expect(auxiliarySpy).not.toHaveBeenCalled()
    expect(hermesClient.completeRequests).toHaveLength(1)
    expect(hermesClient.completeRequests[0]?.hermesSessionId).toBe(
      buildTitleGenerationSessionKey(conversationId),
    )
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
      conversationId,
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
        hermesSessionId: buildTitleGenerationSessionKey(conversationId),
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
      conversationId,
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

  it('rejects stale Hermes output that looks like leaked assistant content', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse(
      "You're at Simon-Dach-Straße 10, Friedrichshain, 10245 Berlin, Germany. ```map ty",
    )
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    const title = await generateConversationTitle(
      hermesClient,
      conversationId,
      'Why was the sbahn not working yesterday in berlin?',
      undefined,
      log,
    )

    expect(title).toBeNull()
    expect(warnings).toEqual([
      {
        message: 'title generation rejected invalid title',
        meta: { reason: 'markdown_fence' },
      },
    ])
  })
})

describe('generateAndSaveTitle', () => {
  it('uses a per-conversation Hermes session key and saves a valid title', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()

    const conversationId = createConversation(db, 'u1', 'hermes-session-1')
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Berlin S-Bahn outage')

    await generateAndSaveTitle({
      db,
      hermesClient,
      hub: new StreamHub(),
      conversationId,
      userId: 'u1',
      userMessageText: 'Why was the sbahn not working yesterday in berlin?',
      originSessionId: null,
    })

    expect(hermesClient.completeRequests).toEqual([
      {
        hermesSessionId: buildTitleGenerationSessionKey(conversationId),
        messages: buildTitlePromptMessages('Why was the sbahn not working yesterday in berlin?'),
      },
    ])

    const row = db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string | null }
    expect(row.title).toBe('Berlin S-Bahn outage')
  })

  it('does not save a rejected title', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()

    const conversationId = createConversation(db, 'u1', 'hermes-session-1')
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Stale map block ```map ty')
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    await generateAndSaveTitle({
      db,
      hermesClient,
      hub: new StreamHub(),
      conversationId,
      userId: 'u1',
      userMessageText: 'Why was the sbahn not working yesterday in berlin?',
      originSessionId: null,
      log,
    })

    const row = db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string | null }
    expect(row.title).toBeNull()
    expect(warnings).toEqual(
      expect.arrayContaining([
        {
          message: 'title generation rejected invalid title',
          meta: { reason: 'markdown_fence' },
        },
        {
          message: 'title generation produced no title',
          meta: { conversationId },
        },
      ]),
    )
  })
})