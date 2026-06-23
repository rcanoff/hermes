import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { listMessages } from '../src/db/repos/messages.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { completeTitleAfterReply, prepareTitleResponse } from './helpers/title.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('user live sync', () => {
  let app: FastifyInstance | undefined
  let hermesClient: FakeHermesClient
  let operatorToken: string
  let conversationId: string
  const openReaders: Array<ReadableStreamDefaultReader<Uint8Array>> = []

  beforeEach(async () => {
    hermesClient = new FakeHermesClient()
    app = await createTestApp({ hermesClient })
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token

    const createConversation = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    conversationId = (createConversation.json() as { id: string }).id
  })

  afterEach(async () => {
    await Promise.all(openReaders.map((reader) => reader.cancel().catch(() => undefined)))
    openReaders.length = 0
    await app?.close()
    app = undefined
  })

  it('emits message_upsert to peer session on POST /messages', async () => {
    const userId = app!.db.prepare(`SELECT id FROM users WHERE username = 'operator'`).pluck().get() as string
    const sessionB = randomUUID()
    const tokenB = await app!.jwt.sign({ sub: userId, username: 'operator', jti: sessionB })

    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const streamB = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const readerB = streamB.body!.getReader()
    openReaders.push(readerB)

    await new Promise((resolve) => setTimeout(resolve, 100))

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Peer sync user message' },
    })
    expect(postResponse.statusCode).toBe(202)

    const userMessageId = (postResponse.json() as { message: { id: string } }).message.id

    const payload = await readUntilMessageUpsert(readerB, userMessageId)
    expect(payload).toContain('event: message_upsert')
    expect(payload).toContain(userMessageId)
    expect(payload).toContain('"role":"user"')
    expect(payload).toContain('Peer sync user message')
  }, 15_000)

  it('emits messages_rewound to peer session on DELETE message', async () => {
    await postAndCompleteAssistant('Rewind sync check')

    const assistantMessageId = listMessages(app!.db, conversationId).find(
      (message) => message.role === 'assistant',
    )!.id

    const userId = app!.db.prepare(`SELECT id FROM users WHERE username = 'operator'`).pluck().get() as string
    const sessionB = randomUUID()
    const tokenB = await app!.jwt.sign({ sub: userId, username: 'operator', jti: sessionB })

    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const streamB = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const readerB = streamB.body!.getReader()
    openReaders.push(readerB)

    await new Promise((resolve) => setTimeout(resolve, 100))

    const deleteResponse = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}/messages/${assistantMessageId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(deleteResponse.statusCode).toBe(200)

    const hermesSessionId = (deleteResponse.json() as { hermes_session_id: string }).hermes_session_id

    const payload = await readUntilMessagesRewound(readerB, assistantMessageId, hermesSessionId)
    expect(payload).toContain('event: messages_rewound')
    expect(payload).toContain(assistantMessageId)
    expect(payload).toContain(hermesSessionId)
    expect(payload).toContain(conversationId)
  }, 15_000)

  it('emits conversation_deleted to peer session on DELETE conversation', async () => {
    await postAndCompleteAssistant('Delete conversation sync check')

    const userId = app!.db.prepare(`SELECT id FROM users WHERE username = 'operator'`).pluck().get() as string
    const sessionB = randomUUID()
    const tokenB = await app!.jwt.sign({ sub: userId, username: 'operator', jti: sessionB })

    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const streamB = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const readerB = streamB.body!.getReader()
    openReaders.push(readerB)

    await new Promise((resolve) => setTimeout(resolve, 100))

    const deleteResponse = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(deleteResponse.statusCode).toBe(204)

    const payload = await readUntilConversationDeleted(readerB, conversationId)
    expect(payload).toContain('event: conversation_deleted')
    expect(payload).toContain(conversationId)
  }, 15_000)

  async function postAndCompleteAssistant(text: string): Promise<void> {
    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text },
    })
    expect(postResponse.statusCode).toBe(202)

    prepareTitleResponse(hermesClient)
    hermesClient.pushAnswerToken('Reply', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)
    await waitFor(() => listMessages(app!.db, conversationId).some((message) => message.role === 'assistant'))
  }
})

async function readUntilMessageUpsert(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  messageId: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let payload = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      payload += decoder.decode(value, { stream: !done })
      if (payload.includes('event: message_upsert') && payload.includes(messageId)) {
        return payload
      }
    }

    if (done) {
      return payload + decoder.decode()
    }
  }
}

async function readUntilMessagesRewound(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  messageId: string,
  hermesSessionId: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let payload = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      payload += decoder.decode(value, { stream: !done })
      if (
        payload.includes('event: messages_rewound') &&
        payload.includes(messageId) &&
        payload.includes(hermesSessionId)
      ) {
        return payload
      }
    }

    if (done) {
      return payload + decoder.decode()
    }
  }
}

async function readUntilConversationDeleted(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  conversationId: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let payload = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      payload += decoder.decode(value, { stream: !done })
      if (payload.includes('event: conversation_deleted') && payload.includes(conversationId)) {
        return payload
      }
    }

    if (done) {
      return payload + decoder.decode()
    }
  }
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