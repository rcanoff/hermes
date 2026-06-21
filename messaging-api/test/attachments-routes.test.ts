import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildMultipartImagePayload, createTinyJpegBuffer } from './helpers/attachments.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('attachment routes', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let otherUserToken: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token

    const otherUserId = randomUUID()
    app.db
      .prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`)
      .run(otherUserId, 'other-user', 'unused-hash')
    otherUserToken = await app.jwt.sign({ sub: otherUserId, username: 'other-user' })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('uploads and downloads an attachment for the owner', async () => {
    const jpeg = await createTinyJpegBuffer()
    const boundary = 'testboundary'
    const upload = await app!.inject({
      method: 'POST',
      url: '/attachments',
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartImagePayload(jpeg, boundary, 'photo.jpg', 'image/jpeg'),
    })

    expect(upload.statusCode).toBe(201)
    const { attachment } = upload.json() as { attachment: { id: string } }

    const thumb = await app!.inject({
      method: 'GET',
      url: `/attachments/${attachment.id}?variant=thumb`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(thumb.statusCode).toBe(200)
    expect(thumb.headers['content-type']).toMatch(/image\/jpeg/)
  })

  it('returns 404 when another user downloads the attachment', async () => {
    const jpeg = await createTinyJpegBuffer()
    const boundary = 'testboundary2'
    const upload = await app!.inject({
      method: 'POST',
      url: '/attachments',
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartImagePayload(jpeg, boundary, 'photo.jpg', 'image/jpeg'),
    })
    const { attachment } = upload.json() as { attachment: { id: string } }

    const denied = await app!.inject({
      method: 'GET',
      url: `/attachments/${attachment.id}`,
      headers: { authorization: `Bearer ${otherUserToken}` },
    })
    expect(denied.statusCode).toBe(404)
  })
})