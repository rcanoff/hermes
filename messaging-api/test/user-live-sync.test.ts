import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { FakeHermesClient } from './helpers/hermes.js'
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