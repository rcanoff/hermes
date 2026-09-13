import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { insertBot } from '../src/db/repos/bots.js'
import { createConversation } from '../src/db/repos/conversations.js'
import { getActiveRun } from '../src/db/repos/runs.js'
import { insertMessage, listMessages } from '../src/db/repos/messages.js'
import { getProcessByAssistantMessageIds } from '../src/db/repos/process.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { GrokGatewayError } from '../src/services/grok-gateway-client.js'
import { FakeGrokGatewayClient } from './helpers/grok-gateway.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'
import { prepareTitleResponse } from './helpers/title.js'
import type { SessionStreamEvent } from '../src/streams/hub.js'

describe('grok send path', () => {
  let app: FastifyInstance | undefined
  let hermesClient: FakeHermesClient
  let grokClient: FakeGrokGatewayClient
  let token: string
  let userId: string
  let sessionId: string
  let grokBotId: string
  let conversationId: string

  beforeEach(async () => {
    hermesClient = new FakeHermesClient()
    grokClient = new FakeGrokGatewayClient()
    app = await createTestApp({ hermesClient, grokGatewayClient: grokClient })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    token = seeded.token
    userId = seeded.id
    sessionId = seeded.sessionId
    app.streamHub.registerUserSession(userId, sessionId)

    const createdBot = await app.inject({
      method: 'POST',
      url: '/bots',
      headers: authHeaders(),
      payload: { name: 'Grok', role: 'Local Mac agent.', runtime: 'grok' },
    })
    grokBotId = (createdBot.json() as { id: string }).id

    const createdConversation = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: authHeaders(),
      payload: { bot_id: grokBotId },
    })
    conversationId = (createdConversation.json() as { id: string }).id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function authHeaders() {
    return { authorization: `Bearer ${token}` }
  }

  it('sends on a grok conversation via the gateway, never Hermes', async () => {
    prepareTitleResponse(hermesClient, 'Hi')
    const events: SessionStreamEvent[] = []
    app!.streamHub.subscribeSession(sessionId, (event) => events.push(event))

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: authHeaders(),
      payload: { text: 'Hello Grok' },
    })
    expect(response.statusCode).toBe(202)

    grokClient.pushEvent({ type: 'token', text: 'Hi from Mac' })
    grokClient.pushDone()
    grokClient.close()

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    expect(hermesClient.requests).toHaveLength(0)
    expect(grokClient.putSessions).toEqual([
      expect.objectContaining({ conversationId, model: 'grok-4.6' }),
    ])
    expect(grokClient.prompts).toEqual([
      { conversationId, text: 'Hello Grok', user_id: userId },
    ])
    expect(listMessages(app!.db, conversationId)[1]).toMatchObject({
      role: 'assistant',
      content: 'Hi from Mac',
    })
    expect(events.some((event) => event.event === 'error')).toBe(false)
  })

  it('coalesces word-by-word grok reasoning into one process line', async () => {
    const events: SessionStreamEvent[] = []
    app!.streamHub.subscribeSession(sessionId, (event) => events.push(event))

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: authHeaders(),
      payload: { text: 'ping' },
    })
    expect(response.statusCode).toBe(202)

    grokClient.pushEvent({ type: 'tooling', phase: 'reasoning', text: 'The' })
    grokClient.pushEvent({ type: 'tooling', phase: 'reasoning', text: ' user' })
    grokClient.pushEvent({ type: 'tooling', phase: 'reasoning', text: ' asked' })
    grokClient.pushEvent({ type: 'token', text: 'pong' })
    grokClient.pushDone()
    grokClient.close()

    await waitFor(() => listMessages(app!.db, conversationId).some((message) => message.content === 'pong'))

    const assistant = listMessages(app!.db, conversationId).find((message) => message.role === 'assistant')!
    const process = getProcessByAssistantMessageIds(app!.db, [assistant.id]).get(assistant.id)
    expect(process?.lines).toEqual([{ phase: 'reasoning', text: 'The user asked' }])

    const reasoningTooling = events.filter(
      (event) => event.event === 'tooling' && event.data.phase === 'reasoning',
    )
    expect(reasoningTooling.filter((event) => event.data.draft === true)).toHaveLength(3)
    expect(reasoningTooling.filter((event) => event.data.draft !== true)).toEqual([
      {
        event: 'tooling',
        data: expect.objectContaining({
          phase: 'reasoning',
          text: 'The user asked',
        }),
      },
    ])
  })

  it('marks the run grok_unavailable when the gateway is down; POST still 202', async () => {
    grokClient.down = true
    const events: SessionStreamEvent[] = []
    app!.streamHub.subscribeSession(sessionId, (event) => events.push(event))

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: authHeaders(),
      payload: { text: 'Hello Grok' },
    })
    expect(response.statusCode).toBe(202)

    await waitFor(() => events.some((event) => event.event === 'error'))

    expect(hermesClient.requests).toHaveLength(0)
    expect(getActiveRun(app!.db, conversationId)).toBeUndefined()
    expect(
      app!.db
        .prepare(`SELECT error_code FROM message_runs WHERE conversation_id = ?`)
        .get(conversationId),
    ).toMatchObject({ error_code: 'grok_unavailable' })
    expect(events.some((event) => event.event === 'error' && event.data.code === 'grok_unavailable')).toBe(
      true,
    )
  })

  it('inserts pending_input and resolves allow with 204; stale resolve is 409', async () => {
    const inputId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: authHeaders(),
      payload: { text: 'Run git status' },
    })
    expect(response.statusCode).toBe(202)

    grokClient.pushEvent({
      type: 'pending_input',
      content: 'Run `git status` in ~/Companion/grok?',
      input: {
        id: inputId,
        status: 'pending',
        type: 'permission',
        tool: 'run_terminal_cmd',
        preview: 'git status',
      },
    })

    await waitFor(() =>
      listMessages(app!.db, conversationId).some((message) => message.kind === 'pending_input'),
    )
    const pending = listMessages(app!.db, conversationId).find((message) => message.kind === 'pending_input')!
    expect(pending.input).toMatchObject({
      id: inputId,
      status: 'pending',
      type: 'permission',
      tool: 'run_terminal_cmd',
    })
    expect(getActiveRun(app!.db, conversationId)?.status).toBe('running')

    const allowed = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages/${pending.id}/input`,
      headers: authHeaders(),
      payload: { action: 'allow' },
    })
    expect(allowed.statusCode).toBe(204)
    expect(grokClient.inputs).toEqual([
      { conversationId, input_id: inputId, action: 'allow', text: undefined },
    ])
    expect(listMessages(app!.db, conversationId).find((message) => message.id === pending.id)?.input?.status).toBe(
      'allowed',
    )

    const stale = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages/${pending.id}/input`,
      headers: authHeaders(),
      payload: { action: 'allow' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'not_pending' })

    grokClient.pushEvent({ type: 'token', text: 'On branch main' })
    grokClient.pushDone()
    grokClient.close()
    await waitFor(() => listMessages(app!.db, conversationId).some((message) => message.content === 'On branch main'))
  })

  it('rejects reply on a permission card with 409 invalid_action', async () => {
    const inputId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: authHeaders(),
      payload: { text: 'Write a file' },
    })
    grokClient.pushEvent({
      type: 'pending_input',
      content: 'Write README?',
      input: { id: inputId, status: 'pending', type: 'permission', tool: 'write' },
    })
    await waitFor(() =>
      listMessages(app!.db, conversationId).some((message) => message.kind === 'pending_input'),
    )
    const pending = listMessages(app!.db, conversationId).find((message) => message.kind === 'pending_input')!

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages/${pending.id}/input`,
      headers: authHeaders(),
      payload: { action: 'reply', text: 'nope' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'invalid_action' })
    grokClient.close()
  })

  it('returns 409 run_not_running when the grok run is not active', async () => {
    const inputId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const messageId = insertMessage(app!.db, {
      conversationId,
      role: 'assistant',
      content: 'Run this?',
      kind: 'pending_input',
      input: { id: inputId, status: 'pending', type: 'permission', tool: 'run_terminal_cmd' },
    })

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages/${messageId}/input`,
      headers: authHeaders(),
      payload: { action: 'allow' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'run_not_running' })
  })

  it('creates grok conversations with the Grok TUI default model', async () => {
    expect(
      app!.db
        .prepare('SELECT model, provider FROM conversations WHERE id = ?')
        .get(conversationId),
    ).toEqual({ model: 'grok-4.6', provider: 'grok' })
  })

  it('rejects a Hermes model on a grok conversation with 400 invalid_request', async () => {
    const response = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}`,
      headers: authHeaders(),
      payload: { model: 'gpt-5.4-mini', provider: 'openai-codex' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
    expect(hermesClient.patchSessionModelRequests).toHaveLength(0)
    expect(grokClient.patchSessionModels).toHaveLength(0)
  })

  it('PATCHes a Grok TUI model onto a grok conversation', async () => {
    const response = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}`,
      headers: authHeaders(),
      payload: { model: 'grok-4.5', provider: 'grok' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: conversationId,
      model: 'grok-4.5',
      provider: 'grok',
      model_display: 'grok-4.5',
    })
    expect(
      app!.db
        .prepare('SELECT model, provider FROM conversations WHERE id = ?')
        .get(conversationId),
    ).toEqual({ model: 'grok-4.5', provider: 'grok' })
    expect(grokClient.patchSessionModels).toEqual([{ conversationId, model: 'grok-4.5' }])
    expect(hermesClient.patchSessionModelRequests).toHaveLength(0)
  })

  it('interrupts a hanging grok prompt so the next send gets an assistant reply', async () => {
    const first = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: authHeaders(),
      payload: { text: 'Hey' },
    })
    expect(first.statusCode).toBe(202)

    await waitFor(() => grokClient.prompts.length === 1)
    await waitFor(() => getActiveRun(app!.db, conversationId) != null)

    const interrupt = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/run/interrupt`,
      headers: authHeaders(),
    })
    expect(interrupt.statusCode).toBe(204)
    expect(grokClient.cancels).toEqual([conversationId])
    await waitFor(() => getActiveRun(app!.db, conversationId) == null)

    const second = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: authHeaders(),
      payload: { text: 'Next' },
    })
    expect(second.statusCode).toBe(202)

    await waitFor(() => grokClient.prompts.length === 2)
    grokClient.pushEvent({ type: 'token', text: 'Hello again' }, 1)
    grokClient.pushDone(1)
    grokClient.close(1)

    await waitFor(() =>
      listMessages(app!.db, conversationId).some((message) => message.content === 'Hello again'),
    )

    expect(
      listMessages(app!.db, conversationId).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toEqual([
      { role: 'user', content: 'Hey' },
      { role: 'user', content: 'Next' },
      { role: 'assistant', content: 'Hello again' },
    ])
    const runs = app!.db
      .prepare(`SELECT status, error_code FROM message_runs ORDER BY started_at, id`)
      .all()
    expect(runs).toHaveLength(2)
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'failed', error_code: 'interrupted' }),
        expect.objectContaining({ status: 'completed', error_code: null }),
      ]),
    )
  })

  it('retries once when grok prompt returns prompt_in_flight', async () => {
    grokClient.nextPromptError = new GrokGatewayError('prompt_in_flight')

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: authHeaders(),
      payload: { text: 'Hello' },
    })
    expect(response.statusCode).toBe(202)

    await waitFor(() => grokClient.cancels.includes(conversationId))
    await waitFor(() => grokClient.prompts.length === 2)

    grokClient.pushEvent({ type: 'token', text: 'Hi' })
    grokClient.pushDone()
    grokClient.close()

    await waitFor(() => listMessages(app!.db, conversationId).some((message) => message.content === 'Hi'))
    expect(listMessages(app!.db, conversationId)[1]).toMatchObject({
      role: 'assistant',
      content: 'Hi',
    })
  })

  it('DELETE conversation drops the gateway session', async () => {
    const response = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}`,
      headers: authHeaders(),
    })
    expect(response.statusCode).toBe(204)
    expect(grokClient.deletes).toEqual([conversationId])
  })
})

describe('grok disabled when gateway URL is empty', () => {
  let app: FastifyInstance | undefined
  let hermesClient: FakeHermesClient
  let token: string
  let userId: string
  let sessionId: string

  beforeEach(async () => {
    hermesClient = new FakeHermesClient()
    app = await createTestApp({ hermesClient })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    token = seeded.token
    userId = seeded.id
    sessionId = seeded.sessionId
    app.streamHub.registerUserSession(userId, sessionId)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('fails grok conversation create with grok_unavailable when the gateway is down', async () => {
    const bot = insertBot(app!.db, {
      userId: userId,
      slug: 'grok',
      name: 'Grok',
      role: 'Mac agent',
      soul: 'You are Grok.',
      runtime: 'grok',
    })
    const created = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { bot_id: bot.id },
    })
    expect(created.statusCode).toBe(503)
    expect(created.json()).toEqual({ error: 'grok_unavailable' })
  })

  it('fails grok sends with grok_unavailable and never calls Hermes', async () => {
    const bot = insertBot(app!.db, {
      userId: userId,
      slug: 'grok',
      name: 'Grok',
      role: 'Mac agent',
      soul: 'You are Grok.',
      runtime: 'grok',
    })
    const conversationId = createConversation(app!.db, userId, 'hs-disabled', null, undefined, bot.id)
    const events: SessionStreamEvent[] = []
    app!.streamHub.subscribeSession(sessionId, (event) => events.push(event))

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'Hello' },
    })
    expect(response.statusCode).toBe(202)
    await waitFor(() => events.some((event) => event.event === 'error'))
    expect(hermesClient.requests).toHaveLength(0)
    expect(events.some((event) => event.data.code === 'grok_unavailable')).toBe(true)
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
