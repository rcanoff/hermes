import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { listMessages } from '../src/db/repos/messages.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('session stream', () => {
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

  it('streams tooling and reply on the session opened before POST', async () => {
    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(streamResponse.status).toBe(200)

    const reader = streamResponse.body?.getReader()
    expect(reader).toBeTruthy()
    openReaders.push(reader!)

    await new Promise((resolve) => setTimeout(resolve, 100))

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Stream from session' },
    })
    expect(postResponse.statusCode).toBe(202)

    await waitFor(() => hermesClient.requests.length >= 1)

    hermesClient.pushToolCall('skills_list', '{"category":"productivity"}', 0)
    hermesClient.pushAnswerToken('One skill', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)

    const payload = await readUntilReplyDone(reader!)
    expect(payload).toContain('"kind":"tool"')
    expect(payload).toContain('event: tooling')
    expect(payload).toContain('"phase":"complete"')
    expect(payload).toContain('event: reply')
    expect(payload).toContain('"phase":"done"')

    const stillOpen = await isStreamStillOpen(reader!)
    expect(stillOpen).toBe(true)
  }, 15_000)

  it('does not deliver session A run events to session B', async () => {
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

    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Only for session A' },
    })

    await waitFor(() => hermesClient.requests.length >= 1)

    hermesClient.pushAnswerToken('Hello', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient)

    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const receivedData = await readWithTimeout(readerB, 500)
    expect(receivedData).toBe('')
  }, 15_000)

  it('returns 401 session_required when JWT has no jti', async () => {
    const userId = app!.db.prepare(`SELECT id FROM users WHERE username = 'operator'`).pluck().get() as string
    const legacyToken = await app!.jwt.sign({ sub: userId, username: 'operator' })

    const response = await app!.inject({
      method: 'GET',
      url: '/events/stream',
      headers: { authorization: `Bearer ${legacyToken}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'session_required' })
  })

  it('keeps the session stream open after a run error', async () => {
    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(streamResponse.status).toBe(200)

    const reader = streamResponse.body?.getReader()
    expect(reader).toBeTruthy()
    openReaders.push(reader!)

    await new Promise((resolve) => setTimeout(resolve, 100))

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'This run will fail' },
    })
    expect(postResponse.statusCode).toBe(202)

    await waitFor(() => hermesClient.requests.length >= 1)

    hermesClient.closeWithoutDone(0)

    const payload = await readUntilError(reader!)
    expect(payload).toContain('event: error')
    expect(payload).toContain('"code":"hermes_stream_failed"')

    const stillOpen = await isStreamStillOpen(reader!)
    expect(stillOpen).toBe(true)
  }, 15_000)
})

async function completeTitleAfterReply(hermesClient: FakeHermesClient, title = 'Title'): Promise<void> {
  await waitFor(() => hermesClient.requests.length >= 2)
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

async function readUntilReplyDone(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let payload = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      payload += decoder.decode(value, { stream: !done })
      if (payload.includes('"phase":"done"')) {
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
        return payload
      }
    }

    if (done) {
      return payload + decoder.decode()
    }
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder()
  const result = await Promise.race([
    reader.read().then(({ value, done }) => {
      if (done || !value) {
        return ''
      }
      return decoder.decode(value)
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), timeoutMs)),
  ])
  return result
}

async function isStreamStillOpen(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
  const result = await Promise.race([
    reader.read().then(({ done }) => ({ kind: 'read' as const, done })),
    new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 500)),
  ])

  if (result.kind === 'timeout') {
    return true
  }

  return result.done === false
}