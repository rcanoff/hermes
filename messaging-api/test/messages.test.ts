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
      payload: { text: 'What time is it?' },
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

    completeTitleStream(hermesClient, 'Time check')
    hermesClient.pushAnswerToken('It is', 0)
    hermesClient.pushAnswerToken(' noon', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const messages = listMessages(app!.db, conversationId)
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'What time is it?' }),
      expect.objectContaining({ role: 'assistant', content: 'It is noon' }),
    ])
    expect(getActiveRun(app!.db, conversationId)).toBeUndefined()
    expect(hermesClient.requests).toHaveLength(2)
    expect(hermesClient.requests[0]).toEqual({
      hermesSessionId: expect.any(String),
      messages: [{ role: 'user', content: 'What time is it?' }],
    })
    expect(hermesClient.requests[1]?.messages[0]?.role).toBe('system')
  })

  it('returns conflict when posting while a run is already active', async () => {
    const firstResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'First' },
    })

    expect(firstResponse.statusCode).toBe(202)

    const secondResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Second' },
    })

    expect(secondResponse.statusCode).toBe(409)
    expect(secondResponse.json()).toEqual({ error: 'run_conflict' })
    expect(listMessages(app!.db, conversationId)).toEqual([
      expect.objectContaining({ role: 'user', content: 'First' }),
    ])

    completeTitleStream(hermesClient)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
  })

  it('accepts legacy content field for backward compatibility', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { content: 'Legacy payload' },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      message: expect.objectContaining({ role: 'user', content: 'Legacy payload' }),
    })

    completeTitleStream(hermesClient)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
  })

  it('rejects empty message content', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: '   ' },
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

  it('returns persisted process lines on assistant messages after a tool-heavy run', async () => {
    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Check weather in Lisbon' },
    })
    expect(postResponse.statusCode).toBe(202)

    completeTitleStream(hermesClient)
    hermesClient.pushReasoning('Looking up weather…', 0)
    hermesClient.pushToolCall('lookup_weather', '{"query":"Lisbon"}', 0)
    hermesClient.pushAnswerToken('It is sunny', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const response = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.statusCode).toBe(200)
    const messages = response.json() as Array<{
      role: string
      content: string
      process?: { lines: Array<{ kind: string; text: string }> }
    }>
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Check weather in Lisbon' })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'It is sunny',
      process: {
        lines: [
          { kind: 'reasoning', text: 'Looking up weather…' },
          { kind: 'tool', text: expect.stringContaining('lookup weather') },
        ],
      },
    })
  })

  it('streams events on the same connection when opened before the message post', async () => {
    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const response = await fetch(`http://127.0.0.1:${address.port}/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body?.getReader()
    expect(reader).toBeTruthy()

    await new Promise((resolve) => setTimeout(resolve, 100))

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Stream this early' },
    })
    expect(postResponse.statusCode).toBe(202)

    completeTitleStream(hermesClient)
    hermesClient.pushAnswerToken('Hello', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    const payload = await readUntilDone(reader!)
    expect(payload).toContain('event: token\ndata: {"text":"Hello"}')
    expect(payload).toContain('event: done\ndata: {"messageId":')

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
  })

  it('emits no_active_run error when no run starts within the wait window', async () => {
    await app?.close()
    app = await createTestApp({ hermesClient, streamWaitMs: 100 })
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    const token = (login.json() as { token: string }).token

    const createConversation = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
    })
    const timeoutConversationId = (createConversation.json() as { id: string }).id

    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo

    const response = await fetch(`http://127.0.0.1:${address.port}/conversations/${timeoutConversationId}/stream`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body?.getReader()
    expect(reader).toBeTruthy()

    const payload = await readUntilError(reader!)
    expect(payload).toContain('event: error\ndata: {"code":"no_active_run"}')
  })

  it('streams live events for the current active run only', async () => {
    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Stream this' },
    })
    expect(postResponse.statusCode).toBe(202)

    const response = await fetch(`http://127.0.0.1:${address.port}/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body?.getReader()
    expect(reader).toBeTruthy()

    completeTitleStream(hermesClient)
    hermesClient.pushReasoning('Thinking…', 0)
    hermesClient.pushToolCall('lookup_weather', '{"query":"Lisbon"}', 0)
    hermesClient.pushAnswerToken('Hello', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    const payload = await readUntilDone(reader!)

    expect(payload).toContain('event: process\ndata: {"kind":"reasoning","text":"Thinking…"}')
    expect(payload).toContain('event: process\ndata: {"kind":"tool","text":')
    expect(payload).toContain('event: process_complete\ndata: {}')
    expect(payload).toContain('event: token\ndata: {"text":"Hello"}')
    expect(payload).toContain('event: done\ndata: {"messageId":')

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
  })

  it('auto-generates a title from the first message and emits an SSE title event', async () => {
    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Plan a weekend in Porto' },
    })
    expect(postResponse.statusCode).toBe(202)

    const response = await fetch(`http://127.0.0.1:${address.port}/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const reader = response.body?.getReader()
    expect(reader).toBeTruthy()

    completeTitleStream(hermesClient, 'Porto weekend')
    hermesClient.pushAnswerToken('Here is', 0)
    hermesClient.pushAnswerToken(' an idea', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    const payload = await readUntilTitleOrDone(reader!)
    expect(payload).toContain('event: title\ndata: {"title":"Porto weekend"}')
    expect(payload).toContain('event: done\ndata: {"messageId":')

    await waitFor(() => {
      const row = app!.db
        .prepare('SELECT title FROM conversations WHERE id = ?')
        .get(conversationId) as { title: string | null }
      return row.title === 'Porto weekend'
    })

    expect(hermesClient.requests).toHaveLength(2)
    expect(hermesClient.requests[1]?.messages[0]?.role).toBe('system')
  })

  it('does not auto-generate a title when one is already set', async () => {
    app!.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ?')
      .run('Existing title', conversationId)

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Follow up question' },
    })
    expect(postResponse.statusCode).toBe(202)

    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    expect(hermesClient.requests).toHaveLength(1)
  })

  it('does not overwrite a user title set before auto-generation finishes', async () => {
    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Late title generation' },
    })
    expect(postResponse.statusCode).toBe(202)

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: 'User chosen title' },
    })
    expect(patch.statusCode).toBe(200)

    completeTitleStream(hermesClient, 'Generated title')
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const row = app!.db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string | null }

    expect(row.title).toBe('User chosen title')
  })

  it('edits the latest user message, emits rewind, and persists a new assistant reply', async () => {
    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'What time is it in Lisbon?' },
    })
    expect(postResponse.statusCode).toBe(202)
    const userMessageId = (postResponse.json() as { message: { id: string } }).message.id

    completeTitleStream(hermesClient)
    hermesClient.pushAnswerToken('Lisbon time', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const oldSessionId = (
      app!.db
        .prepare('SELECT hermes_session_id FROM conversations WHERE id = ?')
        .get(conversationId) as { hermes_session_id: string }
    ).hermes_session_id

    const editResponse = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}/messages/${userMessageId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'What time is it in Porto?' },
    })
    expect(editResponse.statusCode).toBe(202)
    expect(editResponse.json()).toMatchObject({
      message: { id: userMessageId, content: 'What time is it in Porto?' },
    })

    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const reader = streamResponse.body?.getReader()
    const rerunStreamId = hermesClient.requests.length - 1

    hermesClient.pushAnswerToken('Porto time', rerunStreamId)
    hermesClient.pushDone(rerunStreamId)
    hermesClient.closeWithoutDone(rerunStreamId)

    const payload = await readUntilTitleOrDone(reader!)
    expect(payload).toContain('event: rewind\ndata: {"removedMessageIds":')
    expect(payload).toContain('event: done\ndata: {"messageId":')

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
    const messages = listMessages(app!.db, conversationId)
    expect(messages).toEqual([
      expect.objectContaining({ id: userMessageId, role: 'user', content: 'What time is it in Porto?' }),
      expect.objectContaining({ role: 'assistant', content: 'Porto time' }),
    ])

    const newSessionId = (
      app!.db
        .prepare('SELECT hermes_session_id FROM conversations WHERE id = ?')
        .get(conversationId) as { hermes_session_id: string }
    ).hermes_session_id
    expect(newSessionId).not.toBe(oldSessionId)
  })

  it('returns edit_not_allowed for non-latest user messages', async () => {
    app!.db.exec(`
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('u1', '${conversationId}', 'user', 'first');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('a1', '${conversationId}', 'assistant', 'one');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('u2', '${conversationId}', 'user', 'second');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('a2', '${conversationId}', 'assistant', 'two');
    `)

    const response = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}/messages/u1`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'edited first' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'edit_not_allowed' })
  })

  it('returns run_conflict when editing during an active assistant run', async () => {
    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Still running' },
    })
    expect(postResponse.statusCode).toBe(202)
    const userMessageId = (postResponse.json() as { message: { id: string } }).message.id

    const response = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}/messages/${userMessageId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Edited while running' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'run_conflict' })

    completeTitleStream(hermesClient)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
  })
})

function completeTitleStream(hermesClient: FakeHermesClient, title = 'Title'): void {
  hermesClient.pushAnswerToken(title, 1)
  hermesClient.pushDone(1)
  hermesClient.closeWithoutDone(1)
}

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
  return readUntilTitleOrDone(reader)
}

async function readUntilTitleOrDone(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
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

async function readUntilError(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let payload = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      payload += decoder.decode(value, { stream: !done })
      if (payload.includes('event: error')) {
        await reader.cancel()
        return payload
      }
    }

    if (done) {
      return payload + decoder.decode()
    }
  }
}
