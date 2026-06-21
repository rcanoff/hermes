import { describe, expect, it } from 'vitest'
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
      },
      companionUsername: 'operator',
    })

    await waitFor(() => hermesClient.ensureSessionRequests.length === 1)

    expect(hermesClient.ensureSessionRequests[0]).toEqual({
      hermesSessionId: 'sess-warm-1',
      systemPrompt: expect.stringContaining(bootstrap),
    })
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