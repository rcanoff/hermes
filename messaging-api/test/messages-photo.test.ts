import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { getActiveRun } from '../src/db/repos/runs.js'
import { buildMultipartImagePayload, createTinyJpegBuffer } from './helpers/attachments.js'
import { createTestApp } from './helpers/app.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { completeTitleAfterReply, prepareTitleResponse } from './helpers/title.js'
import { seedTestUser } from './helpers/users.js'

async function uploadStagedAttachment(app: FastifyInstance, token: string): Promise<string> {
  const jpeg = await createTinyJpegBuffer()
  const boundary = `b-${randomUUID()}`
  const upload = await app.inject({
    method: 'POST',
    url: '/attachments',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: buildMultipartImagePayload(jpeg, boundary, 'photo.jpg', 'image/jpeg'),
  })
  expect(upload.statusCode).toBe(201)
  return (upload.json() as { attachment: { id: string } }).attachment.id
}

async function waitForRunToFinish(app: FastifyInstance, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!getActiveRun(app.db, conversationId)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('run did not finish')
}

describe('photo messages', () => {
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

  it('sends a photo message with caption and returns attachments', async () => {
    const attachmentId = await uploadStagedAttachment(app!, operatorToken)

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'what is this?', attachment_ids: [attachmentId] },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json() as { message: { content: string; attachments: Array<{ id: string }> } }
    expect(body.message.content).toBe('what is this?')
    expect(body.message.attachments).toHaveLength(1)
    expect(body.message.attachments[0].id).toBe(attachmentId)

    prepareTitleResponse(hermesClient, 'Photo item')
    hermesClient.pushAnswerToken('label', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient, 'Photo item')
    await waitForRunToFinish(app!, conversationId)

    const lastUserMessage = hermesClient.requests.at(-1)?.messages.at(-1)
    expect(lastUserMessage?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'what is this?' }),
        expect.objectContaining({ type: 'image_url' }),
      ]),
    )
  })

  it('lists photo messages with attachments', async () => {
    const attachmentId = await uploadStagedAttachment(app!, operatorToken)

    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'photo check', attachment_ids: [attachmentId] },
    })

    prepareTitleResponse(hermesClient, 'Photo check')
    hermesClient.pushAnswerToken('ok', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await completeTitleAfterReply(hermesClient, 'Photo check')
    await waitForRunToFinish(app!, conversationId)

    const list = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(list.statusCode).toBe(200)
    const messages = (list.json() as { messages: Array<{ attachments?: Array<{ id: string }> }> }).messages
    const photoMessage = messages.find((message) => message.attachments?.length === 1)
    expect(photoMessage?.attachments?.[0].id).toBe(attachmentId)
  })
})