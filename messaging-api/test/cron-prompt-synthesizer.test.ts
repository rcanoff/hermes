import { describe, expect, it, vi } from 'vitest'
import { insertMessage, listRecentMessages } from '../src/db/repos/messages.js'
import {
  buildConversationAnchoredCronPromptFallback,
  buildCronPromptSynthesisMessages,
  classifyAndSynthesizeCompanionCronPrompt,
  classifyAndSynthesizeCompanionCronPromptFromConversation,
  cronPromptTopicsConflict,
  CRON_PROMPT_CLASSIFICATION_SYSTEM,
  extractCronPromptTopicSignals,
  findUserTriggerMessage,
  messagesThroughUserTrigger,
  formatConversationExcerpt,
  parseClassifiedCronPromptResponse,
  sanitizeSynthesizedCronPrompt,
  shouldSynthesizeCompanionCronPrompt,
  synthesizeCompanionCronPrompt,
  synthesizeCompanionCronPromptFromConversation,
} from '../src/services/cron-prompt-synthesizer.js'
import type { HermesClient } from '../src/services/hermes-client.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

const OFFLEY_CLASSIFIED_RESPONSE = JSON.stringify({
  kind: 'reminder',
  prompt: `Scheduled reminder. Your entire response must be the user-facing reminder message only — no tool calls, no preamble, no narration.

Output exactly:

Reminder: Buy Offley Rosé.

When we looked earlier, Amazon.de had it around €19.22 for 0.75L with Berlin delivery:
https://www.amazon.de/s?k=Offley+Ros%C3%A9`,
})

const BERMUDA_CLASSIFIED_RESPONSE = JSON.stringify({
  kind: 'reminder',
  prompt: `Scheduled reminder. Your entire response must be the user-facing reminder message only.

Output exactly:

Reminder: Tune Bermuda for the bedroom fan flicker.

Open Home Assistant → Bermuda BLE Trilateration → Configure. Start with smoothing_samples, then test whether room sensors stop bouncing.`,
})

describe('cron-prompt-synthesizer', () => {
  it('requires classification and useful reminders in the system prompt', () => {
    expect(CRON_PROMPT_CLASSIFICATION_SYSTEM).toContain('classify the job kind')
    expect(CRON_PROMPT_CLASSIFICATION_SYSTEM).toContain('NOT ha_digest')
    expect(CRON_PROMPT_CLASSIFICATION_SYSTEM).toContain('links, prices')
    expect(CRON_PROMPT_CLASSIFICATION_SYSTEM).toContain('authoritative')
    expect(CRON_PROMPT_CLASSIFICATION_SYSTEM).not.toContain('exactly one line')
  })

  it('detects topic conflicts between conversation and agent draft', () => {
    const conversation =
      'Mitte rentals with Kalt/Warm lines sorted by Warmmiete: https://www.immobilienscout24.de/expose/168712613'
    const stepsDraft =
      'Daily steps report for companion user operator. Use mcp_companion_get_user_health_history.'

    expect(extractCronPromptTopicSignals(conversation)).toEqual(
      new Set(['immoscout', 'mitte']),
    )
    expect(cronPromptTopicsConflict(conversation, stepsDraft)).toBe(true)
    expect(
      cronPromptTopicsConflict(
        conversation,
        'Daily ImmoScout24 rental search in Friedrichshain, Berlin.',
      ),
    ).toBe(true)
  })

  it('formats recent conversation lines', () => {
    expect(
      formatConversationExcerpt([
        {
          id: '1',
          conversation_id: 'c1',
          role: 'user',
          content: 'Remind me to buy it at 7:30',
          created_at: '2026-06-22 02:46:07',
        },
        {
          id: '2',
          conversation_id: 'c1',
          role: 'assistant',
          content: 'Offley Rosé on Amazon.de — €19.22',
          created_at: '2026-06-22 02:44:41',
        },
      ]),
    ).toContain('Amazon.de')
  })

  it('finds the latest user trigger message', () => {
    expect(
      findUserTriggerMessage([
        {
          id: '1',
          conversation_id: 'c1',
          role: 'assistant',
          content: 'Try smoothing_samples first.',
          created_at: '2026-06-22 03:00:00',
        },
        {
          id: '2',
          conversation_id: 'c1',
          role: 'user',
          content: 'remind me to look into that later at 7pm',
          created_at: '2026-06-22 03:01:00',
        },
      ]),
    ).toBe('remind me to look into that later at 7pm')
  })

  it('still synthesizes one-shot HA-topic reminders', () => {
    expect(
      shouldSynthesizeCompanionCronPrompt({
        name: 'Bermuda tuning follow-up',
        prompt:
          'Reminder: look into tuning Bermuda. Check Bermuda settings in Home Assistant.',
        schedule_display: 'once at 2026-06-22 19:00',
      }),
    ).toBe(true)
  })

  it('skips synthesis only for explicit recurring HA digest jobs', () => {
    expect(
      shouldSynthesizeCompanionCronPrompt({
        name: 'HA daily digest (yesterday)',
        prompt: 'Create a Home Assistant daily report for yesterday.',
        schedule_display: '30 9 * * *',
      }),
    ).toBe(false)
  })

  it('parses classified JSON responses', () => {
    expect(parseClassifiedCronPromptResponse(BERMUDA_CLASSIFIED_RESPONSE)).toEqual({
      kind: 'reminder',
      prompt: expect.stringContaining('Tune Bermuda'),
    })
    expect(parseClassifiedCronPromptResponse('{"kind":"ha_digest","prompt":""}')).toEqual({
      kind: 'ha_digest',
      prompt: null,
    })
  })

  it('builds synthesis messages with conversation first and optional draft prompt', () => {
    const messages = buildCronPromptSynthesisMessages({
      job: {
        name: 'Buy Offley Rosé reminder',
        schedule_display: 'once at 2026-06-22 19:30',
        prompt: 'Reminder: Buy Offley Rosé.',
      },
      messages: [
        {
          id: '1',
          conversation_id: 'c1',
          role: 'assistant',
          content: 'https://www.amazon.de/s?k=Offley+Ros%C3%A9 — €19.22',
          created_at: '2026-06-22 02:44:41',
        },
      ],
      userTriggerMessage: 'remind me to buy it at 7:30 pm',
    })

    expect(messages[0]?.content).toBe(CRON_PROMPT_CLASSIFICATION_SYSTEM)
    expect(messages[1]?.content).toContain('Buy Offley Rosé reminder')
    expect(messages[1]?.content).toContain('Authoritative recent conversation')
    expect(messages[1]?.content).toContain('remind me to buy it at 7:30 pm')
    expect(messages[1]?.content).toContain('Untrusted agent draft')
    expect(messages[1]?.content).toContain('amazon.de')
    expect(messages[1]?.content.indexOf('Authoritative recent conversation')).toBeLessThan(
      messages[1]?.content.indexOf('Untrusted agent draft') ?? -1,
    )
  })

  it('omits conflicting drafts and retries with conversation-only synthesis', async () => {
    const completeChat = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          kind: 'monitoring',
          prompt:
            'Daily steps report for companion user operator. Use mcp_companion_get_user_health_history.',
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          kind: 'monitoring',
          prompt: `Daily ImmoScout24 rental search in Mitte, Berlin.
Canonical URL: https://www.immobilienscout24.de/Suche/de/berlin/berlin/mitte/wohnung-mit-balkon-mieten`,
        }),
      )
    const hermesClient: HermesClient = {
      completeChat,
      async *streamChat() {},
      ensureSession: async () => {},
    }

    const classified = await classifyAndSynthesizeCompanionCronPrompt({
      hermesClient,
      synthesisLlm: { apiKey: '', baseUrl: '', model: 'gpt-5.4', timeoutMs: 30_000 },
      job: {
        name: 'steps-weekly-avg-daily',
        schedule_display: '0 7 * * *',
        prompt:
          'Daily steps report for companion user operator. Use mcp_companion_get_user_health_history.',
      },
      messages: [
        {
          id: '1',
          conversation_id: 'c1',
          role: 'assistant',
          content:
            'Mitte rentals with Kalt/Warm lines sorted by Warmmiete: https://www.immobilienscout24.de/expose/168712613',
          created_at: '2026-06-23 03:00:00',
        },
        {
          id: '2',
          conversation_id: 'c1',
          role: 'user',
          content: 'can you make this into a cron that runs every day at 9am berlin time?',
          created_at: '2026-06-23 03:01:00',
        },
      ],
    })

    expect(classified?.kind).toBe('monitoring')
    expect(classified?.prompt).toContain('Mitte')
    expect(classified?.prompt).not.toContain('get_user_health')
    expect(completeChat).toHaveBeenCalledTimes(2)
    expect(completeChat.mock.calls[0]?.[0]?.messages?.[1]?.content).not.toContain(
      'Untrusted agent draft',
    )
  })

  it('ignores the creating agent reply after the user cron request', async () => {
    const context = messagesThroughUserTrigger([
      {
        id: '1',
        conversation_id: 'c1',
        role: 'assistant',
        content:
          'Mitte rentals: https://www.immobilienscout24.de/Suche/de/berlin/berlin/mitte/wohnung-mit-balkon-mieten',
        created_at: '2026-06-23 03:00:00',
      },
      {
        id: '2',
        conversation_id: 'c1',
        role: 'user',
        content: 'make this a daily cron at 9am berlin',
        created_at: '2026-06-23 03:01:00',
      },
      {
        id: '3',
        conversation_id: 'c1',
        role: 'assistant',
        content: 'Creating the daily steps weekly-average job for operator.',
        created_at: '2026-06-23 03:02:00',
      },
    ])

    expect(context).toHaveLength(2)
    expect(
      cronPromptTopicsConflict(
        context.map((message) => message.content).join('\n'),
        'Daily ImmoScout24 rental search in Mitte, Berlin.',
      ),
    ).toBe(false)
  })

  it('does not fall back to a conflicting agent draft when synthesis fails', async () => {
    const completeChat = vi.fn().mockRejectedValue(new Error('llm unavailable'))
    const hermesClient: HermesClient = {
      completeChat,
      async *streamChat() {},
      ensureSession: async () => {},
    }

    const classified = await classifyAndSynthesizeCompanionCronPrompt({
      hermesClient,
      synthesisLlm: { apiKey: '', baseUrl: '', model: 'gpt-5.4', timeoutMs: 30_000 },
      job: {
        name: 'steps-weekly-avg-daily',
        schedule_display: '0 7 * * *',
        prompt:
          'Daily steps report for companion user operator. Use mcp_companion_get_user_health_history.',
      },
      messages: [
        {
          id: '1',
          conversation_id: 'c1',
          role: 'assistant',
          content:
            'Mitte rentals: https://www.immobilienscout24.de/Suche/de/berlin/berlin/mitte/wohnung-mit-balkon-mieten',
          created_at: '2026-06-23 03:00:00',
        },
        {
          id: '2',
          conversation_id: 'c1',
          role: 'user',
          content: 'make this a daily cron at 9am berlin',
          created_at: '2026-06-23 03:01:00',
        },
      ],
    })

    expect(classified?.prompt).toContain('Mitte')
    expect(classified?.prompt).not.toContain('get_user_health')
  })

  it('builds an ImmoScout fallback prompt from conversation context', () => {
    const prompt = buildConversationAnchoredCronPromptFallback({
      kind: 'monitoring',
      messages: [
        {
          id: '1',
          conversation_id: 'c1',
          role: 'assistant',
          content:
            'Mitte rentals: https://www.immobilienscout24.de/Suche/de/berlin/berlin/mitte/wohnung-mit-balkon-mieten',
          created_at: '2026-06-23 03:00:00',
        },
      ],
      userTriggerMessage: 'daily cron at 9am',
    })

    expect(prompt).toContain('Mitte')
    expect(prompt).toContain('immobilienscout24.de')
  })

  it('strips wrapping code fences from synthesized prompt', () => {
    expect(sanitizeSynthesizedCronPrompt('```\nReminder: Get water.\n```')).toBe(
      'Reminder: Get water.',
    )
  })

  it('classifies and synthesizes reminder prompts via Hermes completeChat', async () => {
    const completeChat = vi.fn().mockResolvedValue(OFFLEY_CLASSIFIED_RESPONSE)
    const hermesClient: HermesClient = {
      completeChat,
      async *streamChat() {},
      ensureSession: async () => {},
    }

    const classified = await classifyAndSynthesizeCompanionCronPrompt({
      hermesClient,
      synthesisLlm: { apiKey: '', baseUrl: '', model: 'gpt-5.4', timeoutMs: 30_000 },
      job: {
        name: 'Buy Offley Rosé reminder',
        schedule_display: 'once at 2026-06-22 19:30',
        prompt: 'Reminder: Buy Offley Rosé.',
      },
      messages: [
        {
          id: '1',
          conversation_id: 'c1',
          role: 'assistant',
          content: 'Amazon.de €19.22 for Offley Rosé',
          created_at: '2026-06-22 02:44:41',
        },
        {
          id: '2',
          conversation_id: 'c1',
          role: 'user',
          content: 'remind me to buy it at 7:30 pm',
          created_at: '2026-06-22 02:46:07',
        },
      ],
    })

    expect(classified?.kind).toBe('reminder')
    expect(classified?.prompt).toContain('amazon.de')
    expect(classified?.prompt).toContain('€19.22')
    expect(completeChat).toHaveBeenCalledOnce()
  })

  it('loads recent messages from the source conversation', async () => {
    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-1', 'regular', datetime('now'))
    `).run(seeded.id)

    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'assistant',
      content: 'Offley Rosé on Amazon.de for €19.22: https://www.amazon.de/s?k=Offley+Ros%C3%A9',
    })
    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'user',
      content: 'remind me to buy it at 7:30 pm',
    })

    expect(listRecentMessages(app.db, 'regular-1', 10)).toHaveLength(2)

    const completeChat = vi.fn().mockResolvedValue(OFFLEY_CLASSIFIED_RESPONSE)
    const hermesClient: HermesClient = {
      completeChat,
      async *streamChat() {},
      ensureSession: async () => {},
    }

    const classified = await classifyAndSynthesizeCompanionCronPromptFromConversation({
      db: app.db,
      hermesClient,
      sourceConversationId: 'regular-1',
      job: {
        name: 'Buy Offley Rosé reminder',
        prompt: 'Reminder: Buy Offley Rosé.',
        schedule_display: 'once at 2026-06-22 19:30',
      },
      synthesisLlm: { apiKey: '', baseUrl: '', model: 'gpt-5.4', timeoutMs: 60_000 },
    })

    expect(classified?.kind).toBe('reminder')
    expect(classified?.prompt).toContain('Offley Rosé')
    expect(classified?.prompt).toContain('amazon.de')
    expect(completeChat).toHaveBeenCalledOnce()

    await app.close()
  })

  it('keeps deprecated synthesize helpers returning reminder prompts only', async () => {
    const completeChat = vi.fn().mockResolvedValue(OFFLEY_CLASSIFIED_RESPONSE)
    const hermesClient: HermesClient = {
      completeChat,
      async *streamChat() {},
      ensureSession: async () => {},
    }

    const prompt = await synthesizeCompanionCronPrompt({
      hermesClient,
      synthesisLlm: { apiKey: '', baseUrl: '', model: 'gpt-5.4', timeoutMs: 30_000 },
      job: {
        name: 'Buy Offley Rosé reminder',
        schedule_display: 'once at 2026-06-22 19:30',
        prompt: 'Reminder: Buy Offley Rosé.',
      },
      messages: [
        {
          id: '1',
          conversation_id: 'c1',
          role: 'user',
          content: 'remind me to buy it at 7:30 pm',
          created_at: '2026-06-22 02:46:07',
        },
      ],
    })

    expect(prompt).toContain('Offley Rosé')

    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-1', 'regular', datetime('now'))
    `).run(seeded.id)
    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'user',
      content: 'remind me to buy it at 7:30 pm',
    })

    const fromConversation = await synthesizeCompanionCronPromptFromConversation({
      db: app.db,
      hermesClient,
      sourceConversationId: 'regular-1',
      job: {
        name: 'Buy Offley Rosé reminder',
        prompt: 'Reminder: Buy Offley Rosé.',
        schedule_display: 'once at 2026-06-22 19:30',
      },
      synthesisLlm: { apiKey: '', baseUrl: '', model: 'gpt-5.4', timeoutMs: 60_000 },
    })

    expect(fromConversation).toContain('Offley Rosé')
    await app.close()
  })
})