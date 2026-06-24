import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConversation } from '../src/db/repos/conversations.js'
import { initSchema } from '../src/db/schema.js'
import * as auxiliaryLlmClient from '../src/services/auxiliary-llm-client.js'
import { buildTitleGenerationSessionKey } from '../src/services/hermes-client.js'
import {
  buildTitlePromptMessages,
  fallbackTitleFromUserMessage,
  generateAndSaveTitle,
  generateConversationTitle,
  generateTitleFromLlm,
  isGrokComposerModel,
  OPENAI_TITLE_FALLBACK_MODEL,
  resolveTitleGenerationLlm,
  sanitizeGeneratedTitle,
  scheduleTitleGeneration,
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

  it('rejects address-like titles', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    const addressTitle =
      "You're at Simon-Dach-Straße 10, Friedrichshain, 10245 Berlin, Germany."
    expect(sanitizeGeneratedTitle(addressTitle, log)).toBeNull()
    expect(warnings).toEqual([
      {
        message: 'title generation rejected invalid title',
        meta: { reason: 'address_like' },
      },
    ])
  })

  it('rejects titles with more than 6 words', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    const tooLong = 'one two three four five six seven'
    expect(sanitizeGeneratedTitle(tooLong, log)).toBeNull()
    expect(warnings).toEqual([
      {
        message: 'title generation rejected invalid title',
        meta: { reason: 'too_many_words', wordCount: 7 },
      },
    ])
  })

  it('rejects titles with excessive whitespace', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log = (message: string, meta?: Record<string, unknown>) => {
      warnings.push({ message, meta })
    }

    expect(sanitizeGeneratedTitle('Grocery   list', log)).toBeNull()
    expect(warnings).toEqual([
      {
        message: 'title generation rejected invalid title',
        meta: { reason: 'whitespace' },
      },
    ])
  })
})

describe('fallbackTitleFromUserMessage', () => {
  it('capitalizes a short greeting', () => {
    expect(fallbackTitleFromUserMessage('hello')).toBe('Hello')
  })

  it('collapses whitespace and caps at 6 words', () => {
    expect(
      fallbackTitleFromUserMessage('hello,   where can I find bucher shops near me'),
    ).toBe('Hello, where can I find bucher')
  })

  it('returns null for empty input', () => {
    expect(fallbackTitleFromUserMessage('   ')).toBeNull()
  })
})

describe('buildTitlePromptMessages', () => {
  it('includes a system instruction and truncated user message', () => {
    const messages = buildTitlePromptMessages('What is the weather in Lisbon?')
    expect(messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining('Do not copy the message verbatim'),
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

describe('isGrokComposerModel', () => {
  it('recognizes grok-composer model names', () => {
    expect(isGrokComposerModel('grok-composer-2.5-fast')).toBe(true)
    expect(isGrokComposerModel('GROK-COMPOSER-3')).toBe(true)
  })

  it('rejects non-grok-composer model names', () => {
    expect(isGrokComposerModel('gpt-4o-mini')).toBe(false)
    expect(isGrokComposerModel('grok-3')).toBe(false)
  })
})

describe('resolveTitleGenerationLlm', () => {
  it('returns null when auxiliary LLM is not configured', () => {
    expect(resolveTitleGenerationLlm(null)).toBeNull()
    expect(
      resolveTitleGenerationLlm({ apiKey: '', baseUrl: '', model: 'gpt-4', timeoutMs: 1000 }),
    ).toBeNull()
  })

  it('maps grok-composer models to gpt-4o-mini when base URL is empty', () => {
    expect(
      resolveTitleGenerationLlm({
        apiKey: 'test-key',
        baseUrl: '',
        model: 'grok-composer-2.5-fast',
        timeoutMs: 5_000,
      }),
    ).toEqual({
      apiKey: 'test-key',
      baseUrl: '',
      model: OPENAI_TITLE_FALLBACK_MODEL,
      timeoutMs: 5_000,
    })
  })

  it('preserves explicit base URL and model when configured', () => {
    const config = {
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'grok-composer-2.5-fast',
      timeoutMs: 5_000,
    }
    expect(resolveTitleGenerationLlm(config)).toEqual(config)
  })
})

describe('generateConversationTitle', () => {
  const conversationId = 'd899b6f6-283b-4632-bbc3-175b0ebfd1fb'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses Hermes when auxiliary LLM is not configured', async () => {
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

  it('prefers auxiliary LLM with OpenAI fallback when grok-composer has no base URL', async () => {
    const hermesClient = new FakeHermesClient()
    const auxiliarySpy = vi
      .spyOn(auxiliaryLlmClient, 'completeAuxiliaryLlm')
      .mockResolvedValue('Hello there')

    const title = await generateConversationTitle(hermesClient, conversationId, 'hello', {
      apiKey: 'test-key',
      baseUrl: '',
      model: 'grok-composer-2.5-fast',
      timeoutMs: 5_000,
    })

    expect(title).toBe('Hello there')
    expect(auxiliarySpy).toHaveBeenCalledWith(
      {
        apiKey: 'test-key',
        baseUrl: '',
        model: OPENAI_TITLE_FALLBACK_MODEL,
        timeoutMs: 5_000,
      },
      buildTitlePromptMessages('hello'),
    )
    expect(hermesClient.completeRequests).toHaveLength(0)
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

  it('falls back to Hermes when auxiliary LLM returns an invalid title', async () => {
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
      'auxiliary title generation returned invalid title; falling back to Hermes',
    )
  })

  it('uses user-message fallback when Hermes returns stale assistant content', async () => {
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

    expect(title).toBe('Why was the sbahn not working')
    expect(warnings).toEqual(
      expect.arrayContaining([
        {
          message: 'title generation rejected invalid title',
          meta: { reason: 'markdown_fence' },
        },
        {
          message: 'Hermes title generation returned invalid title',
          meta: { conversationId },
        },
        {
          message: 'title generation using user-message fallback',
          meta: { conversationId },
        },
      ]),
    )
  })
})

describe('scheduleTitleGeneration', () => {
  it('saves and publishes a provisional title synchronously before LLM work', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()

    const conversationId = createConversation(db, 'u1', 'hermes-session-1')
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Porto weekend')
    const hub = new StreamHub()
    const legacyEvents: Array<{ event: string; data: unknown }> = []
    hub.subscribeLegacy(conversationId, (event) => legacyEvents.push(event))
    hub.registerUserSession('u1', 'sess-1')

    const sessionEvents: Array<{ event: string; data: unknown }> = []
    hub.subscribeSession('sess-1', (event) => sessionEvents.push(event))

    scheduleTitleGeneration({
      db,
      hermesClient,
      hub,
      conversationId,
      userId: 'u1',
      userMessageText: 'Plan a weekend in Porto',
      originSessionId: 'sess-1',
    })

    const row = db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string | null }
    expect(row.title).toBe('Plan a weekend in Porto')
    expect(legacyEvents).toContainEqual({
      event: 'title',
      data: { title: 'Plan a weekend in Porto' },
    })
    expect(sessionEvents).toContainEqual({
      event: 'title',
      data: { conversationId, title: 'Plan a weekend in Porto' },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const upgraded = db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string | null }
    expect(upgraded.title).toBe('Porto weekend')
    expect(legacyEvents.at(-1)).toEqual({
      event: 'title',
      data: { title: 'Porto weekend' },
    })
  })
})

describe('generateTitleFromLlm', () => {
  const conversationId = 'd899b6f6-283b-4632-bbc3-175b0ebfd1fb'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null instead of user-message fallback when Hermes returns invalid title', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Stale map block ```map ty')

    const title = await generateTitleFromLlm(
      hermesClient,
      conversationId,
      'Why was the sbahn not working yesterday in berlin?',
    )

    expect(title).toBeNull()
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

  it('leaves title null when LLM fails and no provisional was set', async () => {
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

  it('upgrades provisional title to LLM title and publishes SSE', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()

    const conversationId = createConversation(db, 'u1', 'hermes-session-1')
    const userMessageText = 'hello'
    const provisionalTitle = fallbackTitleFromUserMessage(userMessageText)!
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(provisionalTitle, conversationId)

    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Greeting')
    const hub = new StreamHub()
    hub.registerUserSession('u1', 'sess-1')
    const sessionEvents: Array<{ event: string; data: unknown }> = []
    hub.subscribeSession('sess-1', (event) => sessionEvents.push(event))

    await generateAndSaveTitle({
      db,
      hermesClient,
      hub,
      conversationId,
      userId: 'u1',
      userMessageText,
      originSessionId: 'sess-1',
    })

    const row = db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string | null }
    expect(row.title).toBe('Greeting')
    expect(sessionEvents).toContainEqual({
      event: 'title',
      data: { conversationId, title: 'Greeting' },
    })
  })

  it('keeps provisional title when LLM returns null', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()

    const conversationId = createConversation(db, 'u1', 'hermes-session-1')
    const userMessageText = 'hello'
    const provisionalTitle = fallbackTitleFromUserMessage(userMessageText)!
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(provisionalTitle, conversationId)

    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('Stale map block ```map ty')
    const hub = new StreamHub()
    hub.registerUserSession('u1', 'sess-1')
    const sessionEvents: Array<{ event: string; data: unknown }> = []
    hub.subscribeSession('sess-1', (event) => sessionEvents.push(event))

    await generateAndSaveTitle({
      db,
      hermesClient,
      hub,
      conversationId,
      userId: 'u1',
      userMessageText,
      originSessionId: 'sess-1',
    })

    const row = db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string | null }
    expect(row.title).toBe(provisionalTitle)
    expect(sessionEvents).toHaveLength(0)
  })
})