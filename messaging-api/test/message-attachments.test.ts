import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../src/db/schema.js'
import {
  deleteExpiredOrphanAttachments,
  insertStagedAttachment,
  linkAttachmentsToMessage,
  listAttachmentsForMessage,
} from '../src/db/repos/message-attachments.js'

describe('message-attachments repo', () => {
  let db: Database.Database
  let userId: string

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db)
    userId = randomUUID()
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`).run(
      userId,
      'u',
      'hash',
    )
  })

  afterEach(() => {
    db.close()
  })

  it('stages and links attachments to a message', () => {
    const messageId = randomUUID()
    const conversationId = randomUUID()
    db.prepare(`INSERT INTO conversations (id, user_id, hermes_session_id) VALUES (?, ?, ?)`).run(
      conversationId,
      userId,
      randomUUID(),
    )
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', '')`).run(
      messageId,
      conversationId,
    )

    const a1 = insertStagedAttachment(db, {
      userId,
      contentType: 'image/jpeg',
      byteSize: 1000,
      width: 100,
      height: 80,
      originalPath: 'original.jpg',
      thumbPath: 'thumb.jpg',
      visionPath: 'vision.jpg',
      orphanTtlHours: 24,
    })
    const a2 = insertStagedAttachment(db, {
      userId,
      contentType: 'image/jpeg',
      byteSize: 1000,
      width: 100,
      height: 80,
      originalPath: 'original.jpg',
      thumbPath: 'thumb.jpg',
      visionPath: 'vision.jpg',
      orphanTtlHours: 24,
    })

    linkAttachmentsToMessage(db, userId, messageId, [a1, a2])

    const rows = listAttachmentsForMessage(db, messageId)
    expect(rows.map((row) => row.id)).toEqual([a1, a2])
    expect(rows[0].position).toBe(0)
    expect(rows[1].position).toBe(1)
  })

  it('deletes expired staged attachments', () => {
    const id = insertStagedAttachment(db, {
      userId,
      contentType: 'image/jpeg',
      byteSize: 1000,
      width: 100,
      height: 80,
      originalPath: 'original.jpg',
      thumbPath: 'thumb.jpg',
      visionPath: 'vision.jpg',
      orphanTtlHours: 24,
    })
    db.prepare(`UPDATE message_attachments SET expires_at = datetime('now', '-1 hour') WHERE id = ?`).run(id)

    const deleted = deleteExpiredOrphanAttachments(db)
    expect(deleted.map((row) => row.id)).toContain(id)
  })
})