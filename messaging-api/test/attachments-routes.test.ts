import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { attachmentRoot } from '../src/lib/attachment-storage.js'
import { buildMultipartImagePayload, createTinyJpegBuffer } from './helpers/attachments.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('attachment routes', () => {
  let app: FastifyInstance | undefined
  let operatorId: string
  let operatorToken: string
  let otherUserToken: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorId = seeded.id
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

  async function uploadFile(filename: string, mime: string, body: Buffer, boundary: string) {
    return app!.inject({
      method: 'POST',
      url: '/attachments',
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartImagePayload(body, boundary, filename, mime),
    })
  }

  it('uploads and downloads an attachment for the owner', async () => {
    const jpeg = await createTinyJpegBuffer()
    const upload = await uploadFile('photo.jpg', 'image/jpeg', jpeg, 'testboundary')

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

  it('uploads a text/plain document and serves original only', async () => {
    const text = Buffer.from('hello from fleet\n', 'utf8')
    const upload = await uploadFile('notes.txt', 'text/plain', text, 'txtboundary')

    expect(upload.statusCode).toBe(201)
    const { attachment } = upload.json() as {
      attachment: {
        id: string
        content_type: string
        byte_size: number
        width: number | null
        height: number | null
      }
    }
    expect(attachment.content_type).toBe('text/plain')
    expect(attachment.byte_size).toBe(text.byteLength)
    expect(attachment.width).toBeNull()
    expect(attachment.height).toBeNull()

    const dir = attachmentRoot(app!.attachmentsDir, operatorId, attachment.id)
    expect(fs.existsSync(path.join(dir, 'original.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'thumb.jpg'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'vision.jpg'))).toBe(false)

    const original = await app!.inject({
      method: 'GET',
      url: `/attachments/${attachment.id}?variant=original`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(original.statusCode).toBe(200)
    expect(original.headers['content-type']).toMatch(/text\/plain/)
    expect(Buffer.from(original.rawPayload)).toEqual(text)

    const thumb = await app!.inject({
      method: 'GET',
      url: `/attachments/${attachment.id}?variant=thumb`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(thumb.statusCode).toBe(400)
    expect(thumb.json()).toEqual({ error: 'unsupported_media_type' })

    const vision = await app!.inject({
      method: 'GET',
      url: `/attachments/${attachment.id}?variant=vision`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(vision.statusCode).toBe(400)
    expect(vision.json()).toEqual({ error: 'unsupported_media_type' })
  })

  it('uploads an application/pdf document and serves original', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8')
    const upload = await uploadFile('doc.pdf', 'application/pdf', pdf, 'pdfboundary')

    expect(upload.statusCode).toBe(201)
    const { attachment } = upload.json() as { attachment: { id: string; content_type: string } }
    expect(attachment.content_type).toBe('application/pdf')

    const original = await app!.inject({
      method: 'GET',
      url: `/attachments/${attachment.id}?variant=original`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(original.statusCode).toBe(200)
    expect(original.headers['content-type']).toMatch(/application\/pdf/)
    expect(Buffer.from(original.rawPayload)).toEqual(pdf)
  })

  it('uploads application/octet-stream and serves original', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff])
    const upload = await uploadFile('blob.bin', 'application/octet-stream', bytes, 'binboundary')

    expect(upload.statusCode).toBe(201)
    const { attachment } = upload.json() as { attachment: { id: string; content_type: string } }
    expect(attachment.content_type).toBe('application/octet-stream')

    const original = await app!.inject({
      method: 'GET',
      url: `/attachments/${attachment.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(original.statusCode).toBe(200)
    expect(original.headers['content-type']).toMatch(/application\/octet-stream/)
    expect(Buffer.from(original.rawPayload)).toEqual(bytes)
  })

  it('rejects unsupported media types', async () => {
    const zip = Buffer.from('PK\u0003\u0004', 'binary')
    const upload = await uploadFile('archive.zip', 'application/zip', zip, 'zipboundary')
    expect(upload.statusCode).toBe(400)
    expect(upload.json()).toEqual({ error: 'unsupported_media_type' })

    const gif = Buffer.from('GIF89a', 'ascii')
    const gifUpload = await uploadFile('anim.gif', 'image/gif', gif, 'gifboundary')
    expect(gifUpload.statusCode).toBe(400)
    expect(gifUpload.json()).toEqual({ error: 'unsupported_media_type' })
  })

  it('returns 404 when another user downloads the attachment', async () => {
    const jpeg = await createTinyJpegBuffer()
    const upload = await uploadFile('photo.jpg', 'image/jpeg', jpeg, 'testboundary2')
    const { attachment } = upload.json() as { attachment: { id: string } }

    const denied = await app!.inject({
      method: 'GET',
      url: `/attachments/${attachment.id}`,
      headers: { authorization: `Bearer ${otherUserToken}` },
    })
    expect(denied.statusCode).toBe(404)
  })
})