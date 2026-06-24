import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { createConversation, createJobConversation } from '../src/db/repos/conversations.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { createRun } from '../src/db/repos/runs.js'
import {
  applyConversationModelChange,
  ModelChangeError,
} from '../src/services/conversation-model-change.js'
import { DEFAULT_COMPANION_MODELS } from '../src/lib/companion-models.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('applyConversationModelChange', () => {
  let app: FastifyInstance
  let userId: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    userId = seeded.id
  })

  afterEach(async () => {
    await app.close()
  })

  it('patches Hermes session in place for same-provider model change', async () => {
    const hermesClient = new FakeHermesClient()
    const conversationId = createConversation(app.db, userId, 'hs-original')
    const conversation = app.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as {
      id: string
      user_id: string
      hermes_session_id: string
      kind: 'regular' | 'job'
      title: string | null
      bootstrap_prompt: string | null
      hermes_job_id: string | null
      schedule_display: string | null
      job_enabled: number
      job_last_run_at: string | null
      job_last_status: string | null
      model: string
      provider: string
      created_at: string
      updated_at: string
    }

    const result = await applyConversationModelChange({
      db: app.db,
      hermesClient,
      catalog: DEFAULT_COMPANION_MODELS,
      userId,
      conversation,
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })

    expect(result.providerChanged).toBe(false)
    expect(result.hermesSessionId).toBe('hs-original')
    expect(result.conversation.model).toBe('grok-4.3')
    expect(result.conversation.provider).toBe('xai-oauth')
    expect(hermesClient.patchSessionModelRequests).toEqual([
      { hermesSessionId: 'hs-original', model: 'grok-4.3', provider: 'xai-oauth' },
    ])
    expect(hermesClient.ensureSessionRequests).toHaveLength(0)
    expect(hermesClient.completeRequests).toHaveLength(0)
  })

  it('rotates hermes session and rewarms transcript on provider change', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.queueCompleteChatResponse('OK')

    const conversationId = createConversation(app.db, userId, 'hs-original')
    insertMessage(app.db, { conversationId, role: 'user', content: 'Hello' })
    insertMessage(app.db, { conversationId, role: 'assistant', content: 'Hi there' })

    const conversation = app.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as {
      id: string
      user_id: string
      hermes_session_id: string
      kind: 'regular' | 'job'
      title: string | null
      bootstrap_prompt: string | null
      hermes_job_id: string | null
      schedule_display: string | null
      job_enabled: number
      job_last_run_at: string | null
      job_last_status: string | null
      model: string
      provider: string
      created_at: string
      updated_at: string
    }

    const result = await applyConversationModelChange({
      db: app.db,
      hermesClient,
      catalog: DEFAULT_COMPANION_MODELS,
      userId,
      conversation,
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
      companionUsername: 'operator',
    })

    expect(result.providerChanged).toBe(true)
    expect(result.previousHermesSessionId).toBe('hs-original')
    expect(result.hermesSessionId).not.toBe('hs-original')
    expect(result.conversation.hermes_session_id).toBe(result.hermesSessionId)
    expect(result.conversation.model).toBe('gpt-5.4-mini')
    expect(result.conversation.provider).toBe('openai-codex')
    expect(hermesClient.patchSessionModelRequests).toHaveLength(0)
    expect(hermesClient.ensureSessionRequests).toHaveLength(1)
    expect(hermesClient.ensureSessionRequests[0]?.hermesSessionId).toBe(result.hermesSessionId)
    expect(hermesClient.completeRequests).toHaveLength(1)
    expect(hermesClient.completeRequests[0]?.hermesSessionId).toBe(result.hermesSessionId)
    expect(hermesClient.completeRequests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining('provider changed'),
    })
  })

  it('rejects invalid model pairs', async () => {
    const hermesClient = new FakeHermesClient()
    const conversationId = createConversation(app.db, userId, 'hs-original')
    const conversation = app.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as {
      id: string
      user_id: string
      hermes_session_id: string
      kind: 'regular' | 'job'
      title: string | null
      bootstrap_prompt: string | null
      hermes_job_id: string | null
      schedule_display: string | null
      job_enabled: number
      job_last_run_at: string | null
      job_last_status: string | null
      model: string
      provider: string
      created_at: string
      updated_at: string
    }

    await expect(
      applyConversationModelChange({
        db: app.db,
        hermesClient,
        catalog: DEFAULT_COMPANION_MODELS,
        userId,
        conversation,
        model: 'unknown-model',
        provider: 'xai-oauth',
      }),
    ).rejects.toBeInstanceOf(ModelChangeError)
  })

  it('rejects job conversations', async () => {
    const hermesClient = new FakeHermesClient()
    const conversationId = createJobConversation(app.db, userId, 'operator', { name: 'Daily check' })
    const conversation = app.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as {
      id: string
      user_id: string
      hermes_session_id: string
      kind: 'regular' | 'job'
      title: string | null
      bootstrap_prompt: string | null
      hermes_job_id: string | null
      schedule_display: string | null
      job_enabled: number
      job_last_run_at: string | null
      job_last_status: string | null
      model: string
      provider: string
      created_at: string
      updated_at: string
    }

    await expect(
      applyConversationModelChange({
        db: app.db,
        hermesClient,
        catalog: DEFAULT_COMPANION_MODELS,
        userId,
        conversation,
        model: 'grok-4.3',
        provider: 'xai-oauth',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('rejects active runs', async () => {
    const hermesClient = new FakeHermesClient()
    const conversationId = createConversation(app.db, userId, 'hs-original')
    const messageId = insertMessage(app.db, { conversationId, role: 'user', content: 'pending' })
    createRun(app.db, conversationId, messageId, 'legacy')

    const conversation = app.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as {
      id: string
      user_id: string
      hermes_session_id: string
      kind: 'regular' | 'job'
      title: string | null
      bootstrap_prompt: string | null
      hermes_job_id: string | null
      schedule_display: string | null
      job_enabled: number
      job_last_run_at: string | null
      job_last_status: string | null
      model: string
      provider: string
      created_at: string
      updated_at: string
    }

    await expect(
      applyConversationModelChange({
        db: app.db,
        hermesClient,
        catalog: DEFAULT_COMPANION_MODELS,
        userId,
        conversation,
        model: 'grok-4.3',
        provider: 'xai-oauth',
      }),
    ).rejects.toMatchObject({ code: 'run_conflict' })
  })
})

describe('PATCH /conversations/:id model change', () => {
  let app: FastifyInstance
  let operatorToken: string
  const openReaders: Array<ReadableStreamDefaultReader<Uint8Array>> = []

  beforeEach(async () => {
    const hermesClient = new FakeHermesClient()
    app = await createTestApp({ hermesClient })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token
  })

  afterEach(async () => {
    await Promise.all(openReaders.map((reader) => reader.cancel().catch(() => undefined)))
    openReaders.length = 0
    await app.close()
  })

  it('returns updated conversation with model_display for same-provider PATCH', async () => {
    const hermesClient = (app as FastifyInstance & { hermesClient: FakeHermesClient }).hermesClient

    const create = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string; hermes_session_id: string }

    const patch = await app.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { model: 'grok-4.3', provider: 'xai-oauth' },
    })

    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({
      id: conversation.id,
      hermes_session_id: conversation.hermes_session_id,
      model: 'grok-4.3',
      provider: 'xai-oauth',
      model_display: 'Grok 4.3',
    })
    expect(hermesClient.patchSessionModelRequests).toEqual([
      { hermesSessionId: conversation.hermes_session_id, model: 'grok-4.3', provider: 'xai-oauth' },
    ])
  })

  it('rotates hermes_session_id and emits conversation_upsert on provider change', async () => {
    const hermesClient = (app as FastifyInstance & { hermesClient: FakeHermesClient }).hermesClient
    hermesClient.queueCompleteChatResponse('OK')

    const userId = app.db.prepare(`SELECT id FROM users WHERE username = 'operator'`).pluck().get() as string
    const sessionB = randomUUID()
    const tokenB = await app.jwt.sign({ sub: userId, username: 'operator', jti: sessionB })

    const create = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string; hermes_session_id: string }

    app.db.exec(`
      INSERT INTO messages (id, conversation_id, role, content)
      VALUES ('m1', '${conversation.id}', 'user', 'hello');
    `)

    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo

    const streamB = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const readerB = streamB.body!.getReader()
    openReaders.push(readerB)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const patch = await app.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { model: 'gpt-5.4-mini', provider: 'openai-codex' },
    })

    expect(patch.statusCode).toBe(200)
    const body = patch.json() as {
      hermes_session_id: string
      model: string
      provider: string
      model_display: string
    }
    expect(body.hermes_session_id).not.toBe(conversation.hermes_session_id)
    expect(body).toMatchObject({
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
      model_display: 'GPT 5.4 Mini',
    })

    const payload = await readUntilConversationUpsert(readerB, conversation.id, body.hermes_session_id)
    expect(payload).toContain('event: conversation_upsert')
    expect(payload).toContain('"model":"gpt-5.4-mini"')
    expect(payload).toContain('"provider":"openai-codex"')
    expect(payload).toContain('"model_display":"GPT 5.4 Mini"')
    expect(payload).toContain(`"hermes_session_id":"${body.hermes_session_id}"`)
  }, 15_000)

  it('returns 400 for invalid model', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const patch = await app.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { model: 'unknown', provider: 'xai-oauth' },
    })

    expect(patch.statusCode).toBe(400)
    expect(patch.json()).toEqual({ error: 'invalid_request' })
  })

  it('returns 409 when a run is active', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    app.db.exec(`
      INSERT INTO messages (id, conversation_id, role, content)
      VALUES ('m1', '${conversation.id}', 'user', 'pending');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status)
      VALUES ('r1', '${conversation.id}', 'm1', 'running');
    `)

    const patch = await app.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { model: 'grok-4.3', provider: 'xai-oauth' },
    })

    expect(patch.statusCode).toBe(409)
    expect(patch.json()).toEqual({ error: 'run_conflict' })
  })
})

async function readUntilConversationUpsert(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  conversationId: string,
  hermesSessionId: string,
  timeoutMs = 10_000,
): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    if (
      buffer.includes('event: conversation_upsert') &&
      buffer.includes(conversationId) &&
      buffer.includes(hermesSessionId)
    ) {
      return buffer
    }
  }

  throw new Error('Timed out waiting for conversation_upsert SSE event')
}