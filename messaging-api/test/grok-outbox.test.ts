import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { insertBot } from '../src/db/repos/bots.js'
import { createConversation } from '../src/db/repos/conversations.js'
import { insertMessage, listMessages } from '../src/db/repos/messages.js'
import { getProcessByAssistantMessageIds } from '../src/db/repos/process.js'
import { getLatestRunForConversation } from '../src/db/repos/runs.js'
import { initSchema, reconcileRunningRuns } from '../src/db/schema.js'
import { DEFAULT_COMPANION_MODELS } from '../src/lib/companion-models.js'
import { HttpGrokGatewayClient } from '../src/services/grok-gateway-client.js'
import {
  applyOutboxEvents,
  drainGrokOutboxesOnStartup,
} from '../src/services/grok-outbox-drain.js'
import { StreamHub } from '../src/streams/hub.js'
import { createTestApp } from './helpers/app.js'
import { FakeGrokGatewayClient } from './helpers/grok-gateway.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { seedTestUser } from './helpers/users.js'

describe('applyOutboxEvents', () => {
  it('concatenates tokens and coalesces reasoning like the live grok run', () => {
    const applied = applyOutboxEvents([
      {
        seq: 1,
        ts: '2026-09-10T00:00:00.000Z',
        event: { type: 'turn_start', user_id: 'u1', text: 'ping' },
      },
      {
        seq: 2,
        ts: '2026-09-10T00:00:01.000Z',
        event: { type: 'tooling', phase: 'reasoning', text: 'The' },
      },
      {
        seq: 3,
        ts: '2026-09-10T00:00:01.100Z',
        event: { type: 'tooling', phase: 'reasoning', text: ' user' },
      },
      {
        seq: 4,
        ts: '2026-09-10T00:00:01.200Z',
        event: { type: 'tooling', phase: 'activity', text: 'Searching', tool: 'web_search' },
      },
      {
        seq: 5,
        ts: '2026-09-10T00:00:02.000Z',
        event: { type: 'token', text: 'pong' },
      },
      {
        seq: 6,
        ts: '2026-09-10T00:00:02.100Z',
        event: { type: 'done' },
      },
    ])

    expect(applied.assistantText).toBe('pong')
    expect(applied.doneSeq).toBe(6)
    expect(applied.processLines).toEqual([
      { phase: 'reasoning', text: 'The user' },
      { phase: 'activity', text: 'Searching', tool: 'web_search' },
    ])
  })

  it('drops tokens that arrived before tool activity', () => {
    const applied = applyOutboxEvents([
      {
        seq: 1,
        ts: '2026-09-10T00:00:00.000Z',
        event: { type: 'turn_start', user_id: 'u1', text: 'status' },
      },
      {
        seq: 2,
        ts: '2026-09-10T00:00:01.000Z',
        event: { type: 'token', text: 'Fetching live house status now.' },
      },
      {
        seq: 3,
        ts: '2026-09-10T00:00:01.200Z',
        event: { type: 'tooling', phase: 'activity', text: 'ha_get_overview', tool: 'ha_get_overview' },
      },
      {
        seq: 4,
        ts: '2026-09-10T00:00:02.000Z',
        event: { type: 'token', text: 'House is quiet.' },
      },
      {
        seq: 5,
        ts: '2026-09-10T00:00:02.100Z',
        event: { type: 'done' },
      },
    ])

    expect(applied.assistantText).toBe('House is quiet.')
    expect(applied.processLines).toEqual([
      { phase: 'activity', text: 'ha_get_overview', tool: 'ha_get_overview' },
    ])
  })

  it('resets buffers on a later turn_start', () => {
    const applied = applyOutboxEvents([
      {
        seq: 1,
        ts: '2026-09-10T00:00:00.000Z',
        event: { type: 'token', text: 'stale' },
      },
      {
        seq: 2,
        ts: '2026-09-10T00:00:01.000Z',
        event: { type: 'turn_start', user_id: 'u1', text: 'next' },
      },
      {
        seq: 3,
        ts: '2026-09-10T00:00:02.000Z',
        event: { type: 'token', text: 'fresh' },
      },
      {
        seq: 4,
        ts: '2026-09-10T00:00:03.000Z',
        event: { type: 'done' },
      },
    ])

    expect(applied.assistantText).toBe('fresh')
    expect(applied.doneSeq).toBe(4)
  })
})

describe('HttpGrokGatewayClient outbox', () => {
  it('GETs /outbox?after=N and POSTs ack through', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body: string | undefined }> = []
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined })
      if (String(url).includes('/outbox/ack')) {
        return new Response(null, { status: 204 })
      }
      return new Response(
        JSON.stringify({
          events: [
            {
              seq: 2,
              ts: '2026-09-10T00:00:00.000Z',
              event: { type: 'token', text: 'Hi' },
            },
          ],
          last_seq: 2,
          prompt_in_flight: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const client = new HttpGrokGatewayClient('http://grok.test', 'tok')
      const snapshot = await client.fetchOutbox('c1', 1)
      expect(snapshot).toEqual({
        events: [
          {
            seq: 2,
            ts: '2026-09-10T00:00:00.000Z',
            event: { type: 'token', text: 'Hi' },
          },
        ],
        last_seq: 2,
        prompt_in_flight: false,
      })
      await client.ackOutbox('c1', 2)
      expect(calls[0]?.url).toBe('http://grok.test/sessions/c1/outbox?after=1')
      expect(calls[1]?.url).toBe('http://grok.test/sessions/c1/outbox/ack')
      expect(calls[1]?.body).toBe(JSON.stringify({ through: 2 }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('grok outbox drain', () => {
  it('boot with failed run + outbox done persists the assistant and acks', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash')`)
    const bot = insertBot(db, {
      slug: 'grok',
      name: 'Grok',
      role: 'Mac agent',
      soul: 'You are Grok.',
      runtime: 'grok',
    })
    const conversationId = createConversation(db, 'u1', 'hs1', null, undefined, bot.id)
    const userMessageId = insertMessage(db, {
      conversationId,
      role: 'user',
      content: 'Hello Grok',
    })
    db.prepare(`
      INSERT INTO message_runs (id, conversation_id, user_message_id, origin_session_id, status)
      VALUES ('r1', ?, ?, 'legacy', 'running')
    `).run(conversationId, userMessageId)

    expect(reconcileRunningRuns(db)).toBe(1)
    expect(getLatestRunForConversation(db, conversationId)).toMatchObject({
      status: 'failed',
      error_code: 'server_restart',
    })

    const grokClient = new FakeGrokGatewayClient()
    grokClient.setOutbox(conversationId, [
      { type: 'turn_start', user_id: 'u1', text: 'Hello Grok' },
      { type: 'token', text: 'Hi from outbox' },
      { type: 'done' },
    ])

    await drainGrokOutboxesOnStartup({
      db,
      client: grokClient,
      hub: new StreamHub(),
      companionModels: DEFAULT_COMPANION_MODELS,
      pollMs: 5,
      timeoutMs: 200,
    })

    expect(listMessages(db, conversationId).map((message) => message.content)).toEqual([
      'Hello Grok',
      'Hi from outbox',
    ])
    expect(getLatestRunForConversation(db, conversationId)).toMatchObject({
      status: 'completed',
      error_code: null,
    })
    expect(grokClient.acks).toEqual([{ conversationId, through: 3 }])
  })
})

describe('grok live stream drop recovers from outbox', () => {
  let app: FastifyInstance | undefined
  let grokClient: FakeGrokGatewayClient
  let token: string
  let userId: string
  let conversationId: string

  beforeEach(async () => {
    grokClient = new FakeGrokGatewayClient()
    app = await createTestApp({ hermesClient: new FakeHermesClient(), grokGatewayClient: grokClient })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    token = seeded.token
    userId = seeded.id

    const createdBot = await app.inject({
      method: 'POST',
      url: '/bots',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Grok', role: 'Local Mac agent.', runtime: 'grok' },
    })
    const grokBotId = (createdBot.json() as { id: string }).id
    const createdConversation = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { bot_id: grokBotId },
    })
    conversationId = (createdConversation.json() as { id: string }).id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('persists remaining outbox tokens after a mid-stream abort', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'Hello Grok' },
    })
    expect(response.statusCode).toBe(202)
    await waitFor(() => grokClient.prompts.length === 1)

    grokClient.setOutbox(conversationId, [
      { type: 'turn_start', user_id: userId, text: 'Hello Grok' },
      { type: 'token', text: 'Hi' },
      { type: 'token', text: ' from outbox' },
      { type: 'done' },
    ])
    grokClient.pushEvent({ type: 'token', text: 'Hi' })
    const abortErr = new Error('socket hang up')
    abortErr.name = 'AbortError'
    grokClient.fail(abortErr)

    await waitFor(() =>
      listMessages(app!.db, conversationId).some((message) => message.content === 'Hi from outbox'),
    )

    expect(listMessages(app!.db, conversationId)[1]).toMatchObject({
      role: 'assistant',
      content: 'Hi from outbox',
    })
    expect(grokClient.acks).toEqual([{ conversationId, through: 4 }])
    expect(grokClient.cancels).toEqual([])
  })

  it('does not wait for a cancelled turn done on interrupt', async () => {
    const first = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'Hey' },
    })
    expect(first.statusCode).toBe(202)
    await waitFor(() => grokClient.prompts.length === 1)
    await waitFor(() =>
      app!.db
        .prepare(`SELECT status FROM message_runs WHERE conversation_id = ?`)
        .get(conversationId) != null,
    )

    grokClient.setOutbox(conversationId, [
      { type: 'turn_start', user_id: userId, text: 'Hey' },
      { type: 'token', text: 'should not persist' },
      { type: 'done' },
    ])

    const interrupt = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/run/interrupt`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(interrupt.statusCode).toBe(204)
    expect(grokClient.cancels).toEqual([conversationId])

    await waitFor(() => {
      const row = app!.db
        .prepare(`SELECT error_code FROM message_runs WHERE conversation_id = ?`)
        .get(conversationId) as { error_code: string | null } | undefined
      return row?.error_code === 'interrupted'
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(
      listMessages(app!.db, conversationId).some((message) => message.content === 'should not persist'),
    ).toBe(false)
    expect(grokClient.acks).toEqual([])
    expect(
      app!.db
        .prepare(`SELECT status, error_code FROM message_runs WHERE conversation_id = ?`)
        .get(conversationId),
    ).toMatchObject({ status: 'failed', error_code: 'interrupted' })
  })

  it('stores tooling from a drained completed turn', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'ping' },
    })
    expect(response.statusCode).toBe(202)
    await waitFor(() => grokClient.prompts.length === 1)

    grokClient.setOutbox(conversationId, [
      { type: 'tooling', phase: 'reasoning', text: 'Think' },
      { type: 'tooling', phase: 'reasoning', text: 'ing' },
      { type: 'token', text: 'pong' },
      { type: 'done' },
    ])
    grokClient.close()

    await waitFor(() => listMessages(app!.db, conversationId).some((message) => message.content === 'pong'))
    const assistant = listMessages(app!.db, conversationId).find((message) => message.role === 'assistant')!
    expect(getProcessByAssistantMessageIds(app!.db, [assistant.id]).get(assistant.id)?.lines).toEqual([
      { phase: 'reasoning', text: 'Thinking' },
    ])
  })
})

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}
