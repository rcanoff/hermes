import { describe, expect, it, vi } from 'vitest'
import { insertMessage, listRecentMessages } from '../src/db/repos/messages.js'
import {
  buildCronPromptSynthesisMessages,
  classifyAndSynthesizeCompanionCronPrompt,
  classifyAndSynthesizeCompanionCronPromptFromConversation,
  CRON_PROMPT_CLASSIFICATION_SYSTEM,
  findUserTriggerMessage,
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
    expect(CRON_PROMPT_CLASSIFICATION_SYSTEM).not.toContain('exactly one line')
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

  it('builds synthesis messages with trigger, conversation, and draft prompt', () => {
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
    expect(messages[1]?.content).toContain('remind me to buy it at 7:30 pm')
    expect(messages[1]?.content).toContain('amazon.de')
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