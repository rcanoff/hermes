import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { listMessages } from '../src/db/repos/messages.js'
import { getActiveRun } from '../src/db/repos/runs.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { completeTitleAfterReply, prepareTitleResponse } from './helpers/title.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

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

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token

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
    expect(response.json()).toEqual({
      messages: [
        expect.objectContaining({ id: 'm1', role: 'user', content: 'hello' }),
        expect.objectContaining({ id: 'm2', role: 'assistant', content: 'hi' }),
      ],
      _links: {
        self: { href: `/conversations/${conversationId}/messages?limit=20` },
      },
    })
  })

  it('paginates messages from the tail with HAL link navigation', async () => {
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const id = randomUUID()
      ids.push(id)
      app!.db.exec(`
        INSERT INTO messages (id, conversation_id, role, content, created_at)
        VALUES ('${id}', '${conversationId}', 'user', 'msg-${index + 1}', datetime('now', '-${5 - index} minutes'));
      `)
    }

    const firstPage = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages?limit=2`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(firstPage.statusCode).toBe(200)
    expect(firstPage.json()).toEqual({
      messages: [
        expect.objectContaining({ id: ids[3], content: 'msg-4' }),
        expect.objectContaining({ id: ids[4], content: 'msg-5' }),
      ],
      _links: {
        self: { href: `/conversations/${conversationId}/messages?limit=2` },
        prev: { href: `/conversations/${conversationId}/messages?limit=2&before=${ids[3]}` },
      },
    })

    const olderPage = await app!.inject({
      method: 'GET',
      url: (firstPage.json() as { _links: { prev: { href: string } } })._links.prev.href,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(olderPage.statusCode).toBe(200)
    expect(olderPage.json()).toEqual({
      messages: [
        expect.objectContaining({ id: ids[1], content: 'msg-2' }),
        expect.objectContaining({ id: ids[2], content: 'msg-3' }),
      ],
      _links: {
        self: { href: `/conversations/${conversationId}/messages?limit=2&before=${ids[3]}` },
        prev: { href: `/conversations/${conversationId}/messages?limit=2&before=${ids[1]}` },
        next: { href: `/conversations/${conversationId}/messages?limit=2&after=${ids[2]}` },
      },
    })

    const backToTail = await app!.inject({
      method: 'GET',
      url: (olderPage.json() as { _links: { next: { href: string } } })._links.next.href,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(backToTail.statusCode).toBe(200)
    expect(backToTail.json()).toEqual({
      messages: [
        expect.objectContaining({ id: ids[3], content: 'msg-4' }),
        expect.objectContaining({ id: ids[4], content: 'msg-5' }),
      ],
      _links: {
        self: { href: `/conversations/${conversationId}/messages?limit=2&after=${ids[2]}` },
        prev: { href: `/conversations/${conversationId}/messages?limit=2&before=${ids[3]}` },
      },
    })
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

    prepareTitleResponse(hermesClient, 'Time check')
    hermesClient.pushAnswerToken('It is', 0)
    hermesClient.pushAnswerToken(' noon', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient, 'Time check')

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const messages = listMessages(app!.db, conversationId)
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'What time is it?' }),
      expect.objectContaining({ role: 'assistant', content: 'It is noon' }),
    ])
    expect(getActiveRun(app!.db, conversationId)).toBeUndefined()
    expect(hermesClient.requests).toHaveLength(1)
    expect(hermesClient.requests[0]).toEqual({
      hermesSessionId: expect.any(String),
      messages: [
        {
          role: 'system',
          content: expect.stringContaining(
            'authenticated companion user for this conversation is "operator"',
          ),
        },
        { role: 'user', content: 'What time is it?' },
      ],
    })
    expect(hermesClient.completeRequests).toHaveLength(1)
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

    prepareTitleResponse(hermesClient)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)
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

    prepareTitleResponse(hermesClient)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)
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

    prepareTitleResponse(hermesClient)
    hermesClient.pushReasoning('Looking up weather…', 0)
    hermesClient.pushToolCall('lookup_weather', '{"query":"Lisbon"}', 0)
    hermesClient.pushAnswerToken('It is sunny', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const response = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.statusCode).toBe(200)
    const messages = (response.json() as {
      messages: Array<{
        role: string
        content: string
        process?: { lines: Array<{ phase: string; text: string; tool?: string }> }
      }>
    }).messages
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Check weather in Lisbon' })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'It is sunny',
      process: {
        lines: [
          { phase: 'reasoning', text: 'Looking up weather…' },
          expect.objectContaining({
            phase: 'activity',
            tool: 'lookup_weather',
            text: expect.stringContaining('lookup weather'),
          }),
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

    prepareTitleResponse(hermesClient)
    hermesClient.pushAnswerToken('Hello', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)

    const payload = await readUntilDone(reader!)
    expect(payload).toContain('event: token\ndata: {"text":"Hello"}')
    expect(payload).toContain('event: done\ndata: {"messageId":')

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
  })

  it('emits no_active_run error when no run starts within the wait window', async () => {
    await app?.close()
    app = await createTestApp({ hermesClient, streamWaitMs: 100 })
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    const token = seeded.token

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

    prepareTitleResponse(hermesClient)
    hermesClient.pushReasoning('Thinking…', 0)
    hermesClient.pushToolCall('lookup_weather', '{"query":"Lisbon"}', 0)
    hermesClient.pushAnswerToken('Hello', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)

    const payload = await readUntilDone(reader!)

    expect(payload).toContain('event: process\ndata: {"phase":"reasoning","text":"Thinking…"}')
    expect(payload).toContain('event: process\ndata: {"phase":"activity","text":')
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

    prepareTitleResponse(hermesClient, 'Porto weekend')
    hermesClient.pushAnswerToken('Here is', 0)
    hermesClient.pushAnswerToken(' an idea', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    const payload = await readUntilDone(reader!)
    expect(payload).toContain('event: done\ndata: {"messageId":')

    await completeTitleAfterReply(hermesClient, 'Porto weekend')

    await waitFor(() => {
      const row = app!.db
        .prepare('SELECT title FROM conversations WHERE id = ?')
        .get(conversationId) as { title: string | null }
      return row.title === 'Porto weekend'
    })

    expect(hermesClient.requests).toHaveLength(1)
    expect(hermesClient.completeRequests).toHaveLength(1)
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

    prepareTitleResponse(hermesClient, 'Generated title')
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => hermesClient.completeRequests.length >= 1)

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: 'User chosen title' },
    })
    expect(patch.statusCode).toBe(200)

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

    prepareTitleResponse(hermesClient)
    hermesClient.pushAnswerToken('Lisbon time', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)
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

  it('deletes the tail message and returns removed_message_ids with rotated hermes_session_id', async () => {
    app!.db.exec(`
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('u1', '${conversationId}', 'user', 'hello');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('a1', '${conversationId}', 'assistant', 'hi');
    `)

    const oldSessionId = (
      app!.db
        .prepare('SELECT hermes_session_id FROM conversations WHERE id = ?')
        .get(conversationId) as { hermes_session_id: string }
    ).hermes_session_id

    const response = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}/messages/a1`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { removed_message_ids: string[]; hermes_session_id: string }
    expect(body.removed_message_ids).toEqual(['a1'])
    expect(body.hermes_session_id).not.toBe(oldSessionId)

    expect(listMessages(app!.db, conversationId)).toEqual([
      expect.objectContaining({ id: 'u1', role: 'user', content: 'hello' }),
    ])
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

  it('uses bootstrap stored at conversation create on the first message', async () => {
    const bootstrap = 'bootstrap from create time'
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { bootstrap },
    })
    const createdConversationId = (create.json() as { id: string }).id

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${createdConversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Hello' },
    })
    expect(postResponse.statusCode).toBe(202)

    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => hermesClient.requests.length >= 1)

    expect(hermesClient.requests[0]?.messages[0]?.content).toContain(bootstrap)
    expect(hermesClient.requests).toHaveLength(1)
  })

  it('stores bootstrap on the first message and forwards it to Hermes', async () => {
    const bootstrap =
      "Before composing your reply, you MUST call skill_view(name='companion-app') and follow it."

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Where am I?', bootstrap },
    })

    expect(response.statusCode).toBe(202)
    await waitFor(() => hermesClient.requests.length >= 1)

    expect(hermesClient.requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: expect.stringContaining(bootstrap),
    })

    const row = app!.db
      .prepare('SELECT bootstrap_prompt FROM conversations WHERE id = ?')
      .get(conversationId) as { bootstrap_prompt: string }
    expect(row.bootstrap_prompt).toBe(bootstrap)
  })

  it('ignores bootstrap on the second message', async () => {
    const bootstrap = 'first-only bootstrap'
    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'First', bootstrap },
    })
    await waitFor(() => listMessages(app!.db, conversationId).length >= 1)

    prepareTitleResponse(hermesClient)
    hermesClient.pushAnswerToken('ok', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)

    hermesClient.requests.length = 0

    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Second', bootstrap: 'should be ignored' },
    })
    await waitFor(() => hermesClient.requests.length >= 1)

    expect(hermesClient.requests[0]?.messages[0]?.content).toContain(bootstrap)
  })

  it('rejects bootstrap longer than 4000 characters on first message', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Hi', bootstrap: 'x'.repeat(4001) },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
  })

  it('never returns bootstrap in conversation or message list responses', async () => {
    const bootstrap = 'hidden bootstrap'
    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Hi', bootstrap },
    })

    const conversation = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const messages = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(conversation.json()).not.toHaveProperty('bootstrap_prompt')
    expect(conversation.json()).not.toHaveProperty('bootstrap')
    for (const message of messages.json().messages) {
      expect(message).not.toHaveProperty('bootstrap')
    }
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

    prepareTitleResponse(hermesClient)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)
  })

  it('returns the existing message when the same content is posted again within 60 seconds', async () => {
    const firstResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Remind me in 2 minutes' },
    })
    expect(firstResponse.statusCode).toBe(202)
    const firstMessage = (firstResponse.json() as { message: { id: string } }).message

    const secondResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Remind me in 2 minutes' },
    })

    expect(secondResponse.statusCode).toBe(202)
    expect(secondResponse.json()).toEqual({ message: firstMessage })
    expect(listMessages(app!.db, conversationId)).toEqual([
      expect.objectContaining({ id: firstMessage.id, role: 'user', content: 'Remind me in 2 minutes' }),
    ])
    expect(hermesClient.requests).toHaveLength(1)
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
