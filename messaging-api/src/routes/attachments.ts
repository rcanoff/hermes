import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { FastifyPluginAsync } from 'fastify'
import { isConversationMember } from '../db/repos/conversation-members.js'
import { getMessageById } from '../db/repos/messages.js'
import {
  deleteExpiredOrphanAttachments,
  getAttachmentById,
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
  isAcceptedAttachmentMime,
  isAcceptedImageMime,
  normalizeMime,
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

    const mime = normalizeMime(file.mimetype)
    if (!isAcceptedAttachmentMime(mime)) {
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

    const isImage = isAcceptedImageMime(mime)
    let width: number | null = null
    let height: number | null = null
    let thumbPath = ''
    let visionPath = ''
    if (isImage) {
      try {
        const derivatives = await generateAttachmentDerivatives({
          inputPath: originalPath,
          outputDir,
          thumbMaxEdgePx: app.thumbMaxEdgePx,
          visionMaxEdgePx: app.visionMaxEdgePx,
        })
        width = derivatives.width
        height = derivatives.height
        thumbPath = 'thumb.jpg'
        visionPath = 'vision.jpg'
      } catch {
        removeAttachmentTree(app.attachmentsDir, request.userId, attachmentId)
        return reply.code(500).send({ error: 'processing_failed' })
      }
    }

    const id = insertStagedAttachment(app.db, {
      id: attachmentId,
      userId: request.userId,
      contentType: mime,
      byteSize,
      width,
      height,
      originalPath: originalFilename,
      thumbPath,
      visionPath,
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
    const row = getAttachmentById(app.db, attachmentId)
    if (!row || !canReadAttachment(app.db, request.userId, row)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const variant = parseVariant((request.query as { variant?: string }).variant)
    if ((variant === 'thumb' || variant === 'vision') && !isAcceptedImageMime(row.content_type)) {
      return reply.code(400).send({ error: 'unsupported_media_type' })
    }

    const filename = variantPath(row, variant)
    const absolutePath = resolveAttachmentFile(
      app.attachmentsDir,
      row.user_id,
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

function canReadAttachment(
  db: Parameters<typeof isConversationMember>[0],
  userId: string,
  row: { user_id: string; message_id: string | null },
): boolean {
  if (row.message_id === null) {
    return row.user_id === userId
  }
  const message = getMessageById(db, row.message_id)
  return Boolean(message && isConversationMember(db, message.conversation_id, userId))
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