import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureDefaultBotRow, insertBot } from '../src/db/repos/bots.js'
import { initSchema } from '../src/db/schema.js'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
} from '../src/lib/companion-models.js'
import { scheduleConversationSessionWarmup } from '../src/services/session-warmup.js'
import { FakeHermesClient } from './helpers/hermes.js'

describe('scheduleConversationSessionWarmup', () => {
  it('registers the Hermes session with bootstrap as system prompt', async () => {
    const hermesClient = new FakeHermesClient()
    const bootstrap = "call skill_view(name='companion-app')"

    scheduleConversationSessionWarmup({
      hermesClient,
      conversation: {
        hermes_session_id: 'sess-warm-1',
        bootstrap_prompt: bootstrap,
        model: COMPANION_DEFAULT_MODEL,
        provider: COMPANION_DEFAULT_PROVIDER,
      },
      companionUserId: '11111111-1111-4111-8111-111111111111',
      companionUsername: 'operator',
    })

    await waitFor(() => hermesClient.ensureSessionRequests.length === 1)

    expect(hermesClient.ensureSessionRequests[0]).toEqual({
      hermesSessionId: 'sess-warm-1',
      systemPrompt: expect.stringContaining(bootstrap),
      model: COMPANION_DEFAULT_MODEL,
      provider: COMPANION_DEFAULT_PROVIDER,
      companionUserId: '11111111-1111-4111-8111-111111111111',
      companionUsername: 'operator',
    })
  })

  it('passes conversation model and provider to ensureSession', async () => {
    const hermesClient = new FakeHermesClient()

    scheduleConversationSessionWarmup({
      hermesClient,
      conversation: {
        hermes_session_id: 'sess-warm-2',
        bootstrap_prompt: null,
        model: 'grok-4.3',
        provider: 'xai-oauth',
      },
    })

    await waitFor(() => hermesClient.ensureSessionRequests.length === 1)

    expect(hermesClient.ensureSessionRequests[0]).toMatchObject({
      hermesSessionId: 'sess-warm-2',
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })
    expect(hermesClient.ensureSessionRequests[0]?.profileSlug).toBeUndefined()
  })

  it('passes a non-default bot slug to ensureSession', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash')`).run()
    ensureDefaultBotRow(db, 'u1')
    const travel = insertBot(db, {
      userId: 'u1',
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'You book trips.',
    })
    const hermesClient = new FakeHermesClient()

    scheduleConversationSessionWarmup({
      hermesClient,
      db,
      conversation: {
        user_id: 'u1',
        hermes_session_id: 'sess-warm-3',
        bootstrap_prompt: null,
        model: COMPANION_DEFAULT_MODEL,
        provider: COMPANION_DEFAULT_PROVIDER,
        bot_id: travel.id,
      },
    })

    await waitFor(() => hermesClient.ensureSessionRequests.length === 1)
    expect(hermesClient.ensureSessionRequests[0]?.profileSlug).toBe('u1/travel')
    expect(hermesClient.ensureSessionRequests[0]?.systemPrompt).toContain('You are Travel. Specialty: Flights')
    expect(hermesClient.ensureSessionRequests[0]?.systemPrompt).toContain('set_my_responsibilities')
    expect(hermesClient.ensureSessionRequests[0]?.systemPrompt).toContain(
      '- Hermes (main): Default Companion assistant; routes matching work to specialist teammates.',
    )
  })

  it('omits roster text for job conversations', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash')`).run()
    insertBot(db, {
      userId: 'u1',
      slug: 'travel',
      name: 'Travel',
      role: 'Finds flights, bookings, and tickets.',
      soul: 'You book trips.',
    })
    const hermesClient = new FakeHermesClient()

    scheduleConversationSessionWarmup({
      hermesClient,
      db,
      companionUsername: 'operator',
      conversation: {
        hermes_session_id: 'sess-warm-job',
        bootstrap_prompt: 'You are in a Companion App **job conversation**.',
        kind: 'job',
        hermes_job_id: 'job-1',
        title: 'Daily check',
        schedule_display: 'every day',
        model: COMPANION_DEFAULT_MODEL,
        provider: COMPANION_DEFAULT_PROVIDER,
        bot_id: null,
      },
    })

    await waitFor(() => hermesClient.ensureSessionRequests.length === 1)
    expect(hermesClient.ensureSessionRequests[0]?.systemPrompt).toContain('job conversation')
    expect(hermesClient.ensureSessionRequests[0]?.systemPrompt).not.toContain('Specialty:')
    expect(hermesClient.ensureSessionRequests[0]?.systemPrompt).not.toContain(
      'Teammates on this Companion instance',
    )
  })
})

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for condition')
}