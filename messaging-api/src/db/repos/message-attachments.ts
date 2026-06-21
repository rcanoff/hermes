import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface AttachmentRow {
  id: string
  user_id: string
  message_id: string | null
  position: number
  content_type: string
  byte_size: number
  width: number | null
  height: number | null
  original_path: string
  thumb_path: string
  vision_path: string
  created_at: string
  expires_at: string | null
}

export interface InsertStagedAttachmentInput {
  id?: string
  userId: string
  contentType: string
  byteSize: number
  width: number | null
  height: number | null
  originalPath: string
  thumbPath: string
  visionPath: string
  orphanTtlHours: number
}

export interface ExpiredOrphanAttachment {
  id: string
  user_id: string
}

export function insertStagedAttachment(
  db: Database.Database,
  input: InsertStagedAttachmentInput,
): string {
  const id = input.id ?? randomUUID()
  db.prepare(`
    INSERT INTO message_attachments (
      id, user_id, message_id, position, content_type, byte_size, width, height,
      original_path, thumb_path, vision_path, expires_at
    ) VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?,
      datetime('now', '+' || ? || ' hours'))
  `).run(
    id,
    input.userId,
    input.contentType,
    input.byteSize,
    input.width,
    input.height,
    input.originalPath,
    input.thumbPath,
    input.visionPath,
    input.orphanTtlHours,
  )
  return id
}

export function getAttachmentForUser(
  db: Database.Database,
  userId: string,
  attachmentId: string,
): AttachmentRow | undefined {
  return db
    .prepare(`SELECT * FROM message_attachments WHERE id = ? AND user_id = ?`)
    .get(attachmentId, userId) as AttachmentRow | undefined
}

export function listAttachmentsForMessage(
  db: Database.Database,
  messageId: string,
): AttachmentRow[] {
  return db
    .prepare(`
      SELECT * FROM message_attachments
      WHERE message_id = ?
      ORDER BY position ASC, created_at ASC, id ASC
    `)
    .all(messageId) as AttachmentRow[]
}

export function listAttachmentsForMessages(
  db: Database.Database,
  messageIds: string[],
): Map<string, AttachmentRow[]> {
  const map = new Map<string, AttachmentRow[]>()
  if (messageIds.length === 0) {
    return map
  }

  const placeholders = messageIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      SELECT * FROM message_attachments
      WHERE message_id IN (${placeholders})
      ORDER BY message_id, position ASC, created_at ASC, id ASC
    `)
    .all(...messageIds) as AttachmentRow[]

  for (const row of rows) {
    if (!row.message_id) {
      continue
    }
    const bucket = map.get(row.message_id) ?? []
    bucket.push(row)
    map.set(row.message_id, bucket)
  }

  return map
}

export function validateStagedAttachments(
  db: Database.Database,
  userId: string,
  attachmentIds: string[],
): AttachmentRow[] | null {
  if (attachmentIds.length === 0 || attachmentIds.length > 10) {
    return null
  }

  const rows: AttachmentRow[] = []
  for (const id of attachmentIds) {
    const row = getAttachmentForUser(db, userId, id)
    if (!row || row.message_id !== null) {
      return null
    }

    const expired = db
      .prepare(`
        SELECT 1 AS expired
        FROM message_attachments
        WHERE id = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')
      `)
      .get(id) as { expired: number } | undefined
    if (expired) {
      return null
    }

    rows.push(row)
  }

  return rows
}

export function linkAttachmentsToMessage(
  db: Database.Database,
  userId: string,
  messageId: string,
  attachmentIds: string[],
): void {
  attachmentIds.forEach((id, position) => {
    const result = db
      .prepare(`
        UPDATE message_attachments
        SET message_id = ?, position = ?, expires_at = NULL
        WHERE id = ? AND user_id = ? AND message_id IS NULL
      `)
      .run(messageId, position, id, userId)
    if (result.changes !== 1) {
      throw new Error('attachment_link_failed')
    }
  })
}

export function messageHasAttachments(db: Database.Database, messageId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM message_attachments WHERE message_id = ? LIMIT 1`)
    .get(messageId) as { present: number } | undefined
  return Boolean(row)
}

export function deleteExpiredOrphanAttachments(db: Database.Database): ExpiredOrphanAttachment[] {
  const rows = db
    .prepare(`
      SELECT id, user_id
      FROM message_attachments
      WHERE message_id IS NULL AND expires_at IS NOT NULL AND expires_at < datetime('now')
    `)
    .all() as ExpiredOrphanAttachment[]

  if (rows.length === 0) {
    return []
  }

  const ids = rows.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(', ')
  db.prepare(`DELETE FROM message_attachments WHERE id IN (${placeholders})`).run(...ids)
  return rows
}