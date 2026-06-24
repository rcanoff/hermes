import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { publishAccountConversationUpsert } from '../src/streams/sse-mutation-publisher.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('conversation list live sync', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let conversationId: string
  const openReaders: Array<ReadableStreamDefaultReader<Uint8Array>> = []

  beforeEach(async () => {
    app = await createTestApp()
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

  it('fans out conversation_upsert to every connected session for the user', async () => {
    const userId = app!.db.prepare(`SELECT id FROM users WHERE username = 'operator'`).pluck().get() as string
    const sessionA = randomUUID()
    const sessionB = randomUUID()
    const tokenA = await app!.jwt.sign({ sub: userId, username: 'operator', jti: sessionA })
    const tokenB = await app!.jwt.sign({ sub: userId, username: 'operator', jti: sessionB })

    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const streamA = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${tokenA}` },
    })
    const streamB = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const readerA = streamA.body!.getReader()
    const readerB = streamB.body!.getReader()
    openReaders.push(readerA, readerB)

    await new Promise((resolve) => setTimeout(resolve, 100))

    const patchResponse = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: 'Peer list sync title' },
    })
    expect(patchResponse.statusCode).toBe(200)

    publishAccountConversationUpsert(app!.streamHub, app!.db, userId, conversationId)

    const payloadA = await readUntilConversationUpsert(readerA, conversationId, 'Peer list sync title')
    const payloadB = await readUntilConversationUpsert(readerB, conversationId, 'Peer list sync title')

    for (const payload of [payloadA, payloadB]) {
      expect(payload).toContain('event: conversation_upsert')
      expect(payload).toContain(conversationId)
      expect(payload).toContain('"title":"Peer list sync title"')
      expect(payload).toContain('"kind":"regular"')
    }
  }, 15_000)
})

async function readUntilConversationUpsert(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  conversationId: string,
  title: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let payload = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      payload += decoder.decode(value, { stream: !done })
      if (
        payload.includes('event: conversation_upsert') &&
        payload.includes(conversationId) &&
        payload.includes(`"title":"${title}"`)
      ) {
        return payload
      }
    }

    if (done) {
      return payload + decoder.decode()
    }
  }
}