import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { listMessages } from '../src/db/repos/messages.js'
import { getActiveRun } from '../src/db/repos/runs.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { createTestApp } from './helpers/app.js'

describe('message routes', () => {
  let app: FastifyInstance | undefined
  let hermesClient: FakeHermesClient
  let operatorToken: string
  let otherUserToken: string
  let conversationId: string

  beforeEach(async () => {
    hermesClient = new FakeHermesClient()
    app = await createTestApp({ hermesClient })
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    operatorToken = (login.json() as { token: string }).token

    const otherUserId = randomUUID()
    app.db
      .prepare(`
        INSERT INTO users (id, username, password_hash)
        VALUES (?, ?, ?)
      `)
      .run(otherUserId, 'other-user', 'unused-hash')
    otherUserToken = await app.jwt.sign({ sub: otherUserId, username: 'other-user' })

    const createConversation = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    conversationId = (createConversation.json() as { id: string }).id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('lists persisted messages for the conversation owner', async () => {
    app!.db.exec(`
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', '${conversationId}', 'user', 'hello');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m2', '${conversationId}', 'assistant', 'hi');
    `)

    const response = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([
      expect.objectContaining({ id: 'm1', role: 'user', content: 'hello' }),
      expect.objectContaining({ id: 'm2', role: 'assistant', content: 'hi' }),
    ])
  })

  it('accepts a user message, starts durable execution, and persists the final assistant reply', async () => {
    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { content: 'What time is it?' },
    })

    expect(postResponse.statusCode).toBe(202)
    expect(postResponse.json()).toMatchObject({
      message: expect.objectContaining({
        id: expect.any(String),
        conversation_id: conversationId,
        role: 'user',
        content: 'What time is it?',
      }),
    })

    hermesClient.pushToken('It is')
    hermesClient.pushToken(' noon')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const messages = listMessages(app!.db, conversationId)
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'What time is it?' }),
      expect.objectContaining({ role: 'assistant', content: 'It is noon' }),
    ])
    expect(getActiveRun(app!.db, conversationId)).toBeUndefined()
    expect(hermesClient.requests).toEqual([
      {
        hermesSessionId: expect.any(String),
        messages: [{ role: 'user', content: 'What time is it?' }],
      },
    ])
  })

  it('returns conflict when posting while a run is already active', async () => {
    const firstResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { content: 'First' },
    })

    expect(firstResponse.statusCode).toBe(202)

    const secondResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { content: 'Second' },
    })

    expect(secondResponse.statusCode).toBe(409)
    expect(secondResponse.json()).toEqual({ error: 'run_conflict' })
    expect(listMessages(app!.db, conversationId)).toEqual([
      expect.objectContaining({ role: 'user', content: 'First' }),
    ])

    hermesClient.pushDone()
    hermesClient.closeWithoutDone()
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
  })

  it('rejects empty message content', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { content: '   ' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
  })

  it('returns 404 for unauthorized conversation access', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${otherUserToken}` },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'not_found' })
  })

  it('returns no_active_run when opening the stream without a current run', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/stream`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'no_active_run' })
  })

  it('streams live events for the current active run only', async () => {
    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { content: 'Stream this' },
    })
    expect(postResponse.statusCode).toBe(202)

    const response = await fetch(`http://127.0.0.1:${address.port}/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body?.getReader()
    expect(reader).toBeTruthy()

    hermesClient.pushToken('Hello')
    hermesClient.pushTool('lookup_weather')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()

    const payload = await readUntilDone(reader!)

    expect(payload).toContain('event: token\ndata: {"text":"Hello"}')
    expect(payload).toContain('event: tool\ndata: {"name":"lookup_weather"}')
    expect(payload).toContain('event: done\ndata: {"messageId":')

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
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

async function readUntilDone(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let payload = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      payload += decoder.decode(value, { stream: !done })
      if (payload.includes('event: done')) {
        await reader.cancel()
        return payload
      }
    }

    if (done) {
      return payload + decoder.decode()
    }
  }
}
