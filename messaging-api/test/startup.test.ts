import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createRun } from '../src/db/repos/runs.js'
import { listMessages } from '../src/db/repos/messages.js'
import { getActiveRun } from '../src/db/repos/runs.js'
import { initSchema, reconcileRunningRuns } from '../src/db/schema.js'
import { OpenAiHermesClient } from '../src/services/hermes-client.js'
import { buildHermesMessages, buildHermesSystemPrompt } from '../src/services/prompt-builder.js'
import { executeAssistantRun } from '../src/services/run-executor.js'
import { StreamHub } from '../src/streams/hub.js'
import { FakeHermesClient } from './helpers/hermes.js'

describe('startup reconciliation', () => {
  it('marks orphaned running runs as failed', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
    `)

    expect(reconcileRunningRuns(db)).toBe(1)
    const row = db
      .prepare('SELECT status, error_code FROM message_runs WHERE id = ?')
      .get('r1') as { status: string; error_code: string }
    expect(row).toEqual({ status: 'failed', error_code: 'server_restart' })
  })
})

describe('prompt builder', () => {
  const sampleBootstrap =
    "Before composing your reply, you MUST call skill_view(name='companion-app') and follow it."

  it('prepends stored bootstrap before transcript history', () => {
    const messages = buildHermesMessages(
      [{ role: 'user', content: 'Where am I?' }],
      { bootstrapPrompt: sampleBootstrap },
    )

    expect(messages).toEqual([
      { role: 'system', content: sampleBootstrap },
      { role: 'user', content: 'Where am I?' },
    ])
  })

  it('omits system message when bootstrap and username are absent', () => {
    const messages = buildHermesMessages([{ role: 'user', content: 'Hi' }])

    expect(messages).toEqual([{ role: 'user', content: 'Hi' }])
  })

  it('appends username safety line when bootstrap omits username', () => {
    const system = buildHermesSystemPrompt({
      bootstrapPrompt: sampleBootstrap,
      companionUsername: 'roberto',
    })

    expect(system).toContain(sampleBootstrap)
    expect(system).toContain('authenticated companion user for this conversation is "roberto"')
  })

  it('does not duplicate username when bootstrap already includes it', () => {
    const bootstrap = 'The authenticated companion user for this conversation is "roberto".'
    const system = buildHermesSystemPrompt({
      bootstrapPrompt: bootstrap,
      companionUsername: 'roberto',
    })

    expect(system).toBe(bootstrap)
  })
})

describe('durable run execution', () => {
  function seedConversation(db: Database.Database) {
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
    `)
  }

  it('streams Hermes events, persists the assistant reply, and completes the run', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('Hi')
    hermesClient.pushToolCall('lookup_weather', '{}')
    hermesClient.pushAnswerToken(' there')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()

    const hub = new StreamHub()
    const events: Array<{ event: string; data: unknown }> = []
    const unsubscribe = hub.subscribe('c1', (event) => {
      events.push(event)
    })

    const assistantMessageId = await executeAssistantRun({
      db,
      hermesClient,
      hub,
      conversationId: 'c1',
      hermesSessionId: 'hs1',
      userMessageId: 'm1',
      userId: 'u1',
      originSessionId: null,
    })

    unsubscribe()

    expect(assistantMessageId).toEqual(expect.any(String))
    expect(listMessages(db, 'c1')).toEqual([
      expect.objectContaining({ id: 'm1', role: 'user', content: 'hello' }),
      expect.objectContaining({ id: assistantMessageId, role: 'assistant', content: ' there' }),
    ])
    expect(
      db
        .prepare(
          'SELECT status, assistant_message_id, error_code, finished_at FROM message_runs ORDER BY started_at DESC, id DESC LIMIT 1',
        )
        .get(),
    ).toEqual(
      expect.objectContaining({
        status: 'completed',
        assistant_message_id: assistantMessageId,
        error_code: null,
        finished_at: expect.any(String),
      }),
    )
    expect(events).toEqual([
      {
        event: 'process',
        data: { phase: 'status', text: 'Hi', tool: 'lookup_weather', args: null },
      },
      {
        event: 'process',
        data: { phase: 'activity', text: 'Running lookup weather', tool: 'lookup_weather' },
      },
      { event: 'process_complete', data: {} },
      { event: 'token', data: { text: ' there' } },
      { event: 'done', data: { messageId: assistantMessageId } },
    ])
    expect(hermesClient.requests).toEqual([
      {
        hermesSessionId: 'hs1',
        messages: [{ role: 'user', content: 'hello' }],
      },
    ])
  })

  it('marks the run failed and does not persist a fake assistant message when Hermes fails', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('partial')
    hermesClient.fail(new Error('Hermes exploded'))

    const hub = new StreamHub()
    const events: Array<{ event: string; data: unknown }> = []
    hub.subscribe('c1', (event) => {
      events.push(event)
    })

    await expect(
      executeAssistantRun({
        db,
        hermesClient,
        hub,
        conversationId: 'c1',
        hermesSessionId: 'hs1',
        userMessageId: 'm1',
        userId: 'u1',
        originSessionId: null,
      }),
    ).rejects.toThrow('Hermes exploded')

    expect(listMessages(db, 'c1')).toEqual([
      expect.objectContaining({ id: 'm1', role: 'user', content: 'hello' }),
    ])
    expect(
      db
        .prepare('SELECT status, error_code, error_detail, assistant_message_id FROM message_runs LIMIT 1')
        .get(),
    ).toEqual({
      status: 'failed',
      error_code: 'hermes_stream_failed',
      error_detail: 'Hermes exploded',
      assistant_message_id: null,
    })
    expect(events).toEqual([
      { event: 'token', data: { text: 'partial' } },
      { event: 'error', data: { code: 'hermes_stream_failed' } },
    ])
  })

  it('keeps the durable run alive when a stream listener throws', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('safe')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()

    const hub = new StreamHub()
    const delivered: Array<{ event: string; data: unknown }> = []
    hub.subscribe('c1', () => {
      throw new Error('listener exploded')
    })
    hub.subscribe('c1', (event) => {
      delivered.push(event)
    })

    const assistantMessageId = await executeAssistantRun({
      db,
      hermesClient,
      hub,
      conversationId: 'c1',
      hermesSessionId: 'hs1',
      userMessageId: 'm1',
      userId: 'u1',
      originSessionId: null,
    })

    expect(assistantMessageId).toEqual(expect.any(String))
    expect(listMessages(db, 'c1')).toEqual([
      expect.objectContaining({ id: 'm1', role: 'user', content: 'hello' }),
      expect.objectContaining({ id: assistantMessageId, role: 'assistant', content: 'safe' }),
    ])
    expect(delivered).toEqual([
      { event: 'token', data: { text: 'safe' } },
      { event: 'done', data: { messageId: assistantMessageId } },
    ])
  })

  it('rejects starting a second run while one is already active', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)
    db.exec(`
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
    `)

    await expect(
      executeAssistantRun({
        db,
        hermesClient: new FakeHermesClient(),
        hub: new StreamHub(),
        conversationId: 'c1',
        hermesSessionId: 'hs1',
        userMessageId: 'm1',
        userId: 'u1',
        originSessionId: null,
      }),
    ).rejects.toThrow('run_conflict')

    expect(getActiveRun(db, 'c1')).toEqual(
      expect.objectContaining({
        id: 'r1',
        status: 'running',
      }),
    )
  })

  it('normalizes run creation conflicts instead of leaking SQLite constraint errors', () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)
    db.exec(`
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
    `)

    expect(() => createRun(db, 'c1', 'm1', 'legacy')).toThrow('run_conflict')
  })

  it('fails the run when Hermes closes without an explicit done event', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('partial')
    hermesClient.closeWithoutDone()

    const hub = new StreamHub()
    const events: Array<{ event: string; data: unknown }> = []
    hub.subscribe('c1', (event) => {
      events.push(event)
    })

    await expect(
      executeAssistantRun({
        db,
        hermesClient,
        hub,
        conversationId: 'c1',
        hermesSessionId: 'hs1',
        userMessageId: 'm1',
        userId: 'u1',
        originSessionId: null,
      }),
    ).rejects.toThrow('Hermes stream ended without a done event')

    expect(listMessages(db, 'c1')).toEqual([
      expect.objectContaining({ id: 'm1', role: 'user', content: 'hello' }),
    ])
    expect(events).toEqual([
      { event: 'token', data: { text: 'partial' } },
      { event: 'error', data: { code: 'hermes_stream_failed' } },
    ])
  })
})

describe('OpenAiHermesClient', () => {
  it('parses CRLF-framed SSE chunks and requires an explicit done event', async () => {
    const originalFetch = globalThis.fetch
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
          ),
        )
        controller.close()
      },
    })

    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })

    try {
      const client = new OpenAiHermesClient('http://hermes.test')
      const events: Array<{ type: string; text?: string }> = []

      for await (const event of client.streamChat({
        hermesSessionId: 'hs1',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        events.push(event)
      }

      expect(events).toEqual([
        { type: 'answer_token', text: 'Hello' },
        { type: 'done' },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fails truncated CRLF streams that never emit a done event', async () => {
    const originalFetch = globalThis.fetch
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n'),
        )
        controller.close()
      },
    })

    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })

    try {
      const client = new OpenAiHermesClient('http://hermes.test')
      const iterator = client.streamChat({
        hermesSessionId: 'hs1',
        messages: [{ role: 'user', content: 'hello' }],
      })

      await expect(async () => {
        for await (const _event of iterator) {
          // Consume the stream until it fails.
        }
      }).rejects.toThrow('Hermes stream ended without a done event')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
