import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { listMessages } from '../src/db/repos/messages.js'
import { SYNC_MARKER_ORIGIN } from '../src/lib/sync-marker.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { completeTitleAfterReply, prepareTitleResponse } from './helpers/title.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('chat sync routes', () => {
  let app: FastifyInstance | undefined
  let hermesClient: FakeHermesClient
  let operatorToken: string
  let conversationId: string

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
    await app?.close()
    app = undefined
  })

  it('returns origin tip marker for account sync with no events', async () => {
    const otherUserId = randomUUID()
    app!.db
      .prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`)
      .run(otherUserId, 'empty-user', 'hash')
    const otherToken = await app!.jwt.sign({ sub: otherUserId, username: 'empty-user' })

    const response = await app!.inject({
      method: 'GET',
      url: '/conversations/sync',
      headers: { authorization: `Bearer ${otherToken}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      events: [],
      next_sync_marker: SYNC_MARKER_ORIGIN,
      has_more: false,
    })
  })

  it('emits account and conversation events when assistant message completes', async () => {
    await postAndCompleteAssistant('Hello there')

    const list = await app!.inject({
      method: 'GET',
      url: '/conversations/sync',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(list.json().events.some((event: { type: string }) => event.type === 'conversation_upsert')).toBe(
      true,
    )

    const thread = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(thread.statusCode).toBe(200)
    expect(thread.json().events.some((event: { type: string }) => event.type === 'message_upsert')).toBe(
      true,
    )
  })

  it('bootstraps thread marker after HAL hydration with empty events', async () => {
    await postAndCompleteAssistant('Bootstrap me')

    const hydrate = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(hydrate.statusCode).toBe(200)

    const bootstrap = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(bootstrap.statusCode).toBe(200)
    const body = bootstrap.json() as {
      events: unknown[]
      next_sync_marker: string
      conversation: { title: string | null }
    }
    expect(body.events.length).toBeGreaterThan(0)
    expect(body.next_sync_marker).toEqual(expect.any(String))

    const caughtUp = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync?since=${body.next_sync_marker}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(caughtUp.json()).toMatchObject({
      events: [],
      next_sync_marker: body.next_sync_marker,
      has_more: false,
    })
  })

  it('returns sync_marker_invalid for unknown since values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync?since=${randomUUID()}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'sync_marker_invalid' })
  })

  it('returns conversation_deleted on thread sync after delete', async () => {
    await postAndCompleteAssistant('Delete me later')

    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(deleted.statusCode).toBe(204)

    const thread = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(thread.statusCode).toBe(200)
    expect(thread.json()).toMatchObject({
      events: [expect.objectContaining({ type: 'conversation_deleted', conversation_id: conversationId })],
      has_more: false,
    })
  })

  it('returns rewind and replacement events after message edit', async () => {
    await postAndCompleteAssistant('Original question')

    const userMessageId = listMessages(app!.db, conversationId).find((message) => message.role === 'user')!.id

    const edit = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}/messages/${userMessageId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Edited question' },
    })
    expect(edit.statusCode).toBe(202)

    await waitFor(() => hermesClient.requests.length === 2)
    const rerunStreamId = hermesClient.requests.length - 1
    hermesClient.pushAnswerToken('Edited reply', rerunStreamId)
    hermesClient.pushDone(rerunStreamId)
    hermesClient.closeWithoutDone(rerunStreamId)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const thread = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    const eventTypes = (thread.json() as { events: Array<{ type: string }> }).events.map((event) => event.type)
    expect(eventTypes).toContain('messages_rewound')
    expect(eventTypes.filter((type) => type === 'message_upsert').length).toBeGreaterThanOrEqual(2)
  })

  it('returns messages_rewound on thread sync after message delete', async () => {
    await postAndCompleteAssistant('Delete sync check')

    const tipMarker = (
      await app!.inject({
        method: 'GET',
        url: `/conversations/${conversationId}/sync`,
        headers: { authorization: `Bearer ${operatorToken}` },
      })
    ).json().next_sync_marker as string

    const assistantMessageId = listMessages(app!.db, conversationId).find(
      (message) => message.role === 'assistant',
    )!.id

    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}/messages/${assistantMessageId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(deleted.statusCode).toBe(200)

    const thread = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync?since=${tipMarker}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(thread.statusCode).toBe(200)
    const events = (thread.json() as {
      events: Array<{ type: string; removed_message_ids?: string[] }>
    }).events
    const rewind = events.find((event) => event.type === 'messages_rewound')
    expect(rewind).toMatchObject({
      type: 'messages_rewound',
      removed_message_ids: [assistantMessageId],
    })
  })

  it('returns updated conversation snapshot with empty events after title-only patch', async () => {
    await postAndCompleteAssistant('Title snapshot check')

    const tipMarker = (
      await app!.inject({
        method: 'GET',
        url: `/conversations/${conversationId}/sync`,
        headers: { authorization: `Bearer ${operatorToken}` },
      })
    ).json().next_sync_marker as string

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: 'Renamed thread' },
    })
    expect(patch.statusCode).toBe(200)

    const thread = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync?since=${tipMarker}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(thread.statusCode).toBe(200)
    expect(thread.json()).toMatchObject({
      events: [],
      conversation: expect.objectContaining({ title: 'Renamed thread' }),
      has_more: false,
    })
  })

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