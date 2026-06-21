import { describe, expect, it } from 'vitest'
import { COMPANION_TITLE_GENERATION_SESSION_KEY } from '../src/services/hermes-client.js'
import {
  buildTitlePromptMessages,
  generateConversationTitle,
  sanitizeGeneratedTitle,
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

describe('generateConversationTitle', () => {
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
})