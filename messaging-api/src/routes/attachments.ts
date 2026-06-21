import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { FastifyPluginAsync } from 'fastify'
import {
  deleteExpiredOrphanAttachments,
  getAttachmentForUser,
  insertStagedAttachment,
} from '../db/repos/message-attachments.js'
import {
  attachmentRoot,
  ensureDir,
  removeAttachmentTree,
  resolveAttachmentFile,
} from '../lib/attachment-storage.js'
import { serializeAttachment } from '../lib/attachment-serializer.js'
import {
  extensionForMime,
  generateAttachmentDerivatives,
  isAcceptedImageMime,
} from '../services/image-derivatives.js'

type AttachmentVariant = 'original' | 'thumb' | 'vision'

const attachmentRoutes: FastifyPluginAsync = async (app) => {
  app.post('/attachments', { preHandler: app.authenticate }, async (request, reply) => {
    const expired = deleteExpiredOrphanAttachments(app.db)
    for (const orphan of expired) {
      removeAttachmentTree(app.attachmentsDir, orphan.user_id, orphan.id)
    }

    const file = await request.file()
    if (!file) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const mime = file.mimetype.toLowerCase()
    if (!isAcceptedImageMime(mime)) {
      return reply.code(400).send({ error: 'unsupported_media_type' })
    }

    const attachmentId = randomUUID()
    const outputDir = attachmentRoot(app.attachmentsDir, request.userId, attachmentId)
    ensureDir(outputDir)

    const originalFilename = `original${extensionForMime(mime)}`
    const originalPath = resolveAttachmentFile(
      app.attachmentsDir,
      request.userId,
      attachmentId,
      originalFilename,
    )

    let uploadBuffer: Buffer
    try {
      uploadBuffer = await file.toBuffer()
      fs.writeFileSync(originalPath, uploadBuffer)
    } catch {
      removeAttachmentTree(app.attachmentsDir, request.userId, attachmentId)
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const byteSize = uploadBuffer.byteLength
    if (byteSize > app.attachmentMaxBytes) {
      removeAttachmentTree(app.attachmentsDir, request.userId, attachmentId)
      return reply.code(400).send({ error: 'payload_too_large' })
    }

    let derivatives
    try {
      derivatives = await generateAttachmentDerivatives({
        inputPath: originalPath,
        outputDir,
        thumbMaxEdgePx: app.thumbMaxEdgePx,
        visionMaxEdgePx: app.visionMaxEdgePx,
      })
    } catch {
      removeAttachmentTree(app.attachmentsDir, request.userId, attachmentId)
      return reply.code(500).send({ error: 'processing_failed' })
    }

    const id = insertStagedAttachment(app.db, {
      id: attachmentId,
      userId: request.userId,
      contentType: mime,
      byteSize,
      width: derivatives.width,
      height: derivatives.height,
      originalPath: originalFilename,
      thumbPath: 'thumb.jpg',
      visionPath: 'vision.jpg',
      orphanTtlHours: app.attachmentOrphanTtlHours,
    })

    const row = getAttachmentForUser(app.db, request.userId, id)
    if (!row) {
      return reply.code(500).send({ error: 'processing_failed' })
    }

    return reply.code(201).send({ attachment: serializeAttachment(row) })
  })

  app.get('/attachments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const attachmentId = (request.params as { id: string }).id
    const row = getAttachmentForUser(app.db, request.userId, attachmentId)
    if (!row) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const variant = parseVariant((request.query as { variant?: string }).variant)
    const filename = variantPath(row, variant)
    const absolutePath = resolveAttachmentFile(
      app.attachmentsDir,
      request.userId,
      attachmentId,
      filename,
    )

    if (!fs.existsSync(absolutePath)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const contentType = variant === 'original' ? row.content_type : 'image/jpeg'
    return reply
      .header('content-type', contentType)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(fs.createReadStream(absolutePath))
  })
}

function parseVariant(raw: string | undefined): AttachmentVariant {
  if (raw === 'thumb' || raw === 'vision') {
    return raw
  }
  return 'original'
}

function variantPath(
  row: { original_path: string; thumb_path: string; vision_path: string },
  variant: AttachmentVariant,
): string {
  if (variant === 'thumb') {
    return row.thumb_path
  }
  if (variant === 'vision') {
    return row.vision_path
  }
  return row.original_path
}

export default attachmentRoutes