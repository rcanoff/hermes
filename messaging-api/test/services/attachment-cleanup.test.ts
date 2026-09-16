import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteBot } from '../../src/db/repos/bots.js'
import { deleteConversationForUser } from '../../src/db/repos/conversations.js'
import {
  insertStagedAttachment,
  linkAttachmentsToMessage,
} from '../../src/db/repos/message-attachments.js'
import { initSchema } from '../../src/db/schema.js'
import { attachmentRoot } from '../../src/lib/attachment-storage.js'
import {
  drainAttachmentCleanup,
  listAttachmentCleanup,
} from '../../src/services/attachment-cleanup.js'
import { createTestApp } from '../helpers/app.js'
import { seedTestUser } from '../helpers/users.js'

function writeAttachmentTree(root: string, userId: string, attachmentId: string): string {
  const dir = attachmentRoot(root, userId, attachmentId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'original.jpg'), 'orig')
  fs.writeFileSync(path.join(dir, 'thumb.jpg'), 'thumb')
  fs.writeFileSync(path.join(dir, 'vision.jpg'), 'vision')
  return dir
}

function seedConversationWithAttachment(
  db: Database.Database,
  userId: string,
): { conversationId: string; attachmentId: string } {
  const conversationId = randomUUID()
  const messageId = randomUUID()
  db.prepare(`INSERT INTO conversations (id, user_id, hermes_session_id) VALUES (?, ?, ?)`).run(
    conversationId,
    userId,
    randomUUID(),
  )
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', 'hi')`,
  ).run(messageId, conversationId)
  const attachmentId = insertStagedAttachment(db, {
    userId,
    contentType: 'image/jpeg',
    byteSize: 4,
    width: 1,
    height: 1,
    originalPath: 'original.jpg',
    thumbPath: 'thumb.jpg',
    visionPath: 'vision.jpg',
    orphanTtlHours: 24,
  })
  linkAttachmentsToMessage(db, userId, messageId, [attachmentId])
  return { conversationId, attachmentId }
}

describe('attachment cleanup queue', () => {
  let db: Database.Database
  let userId: string
  let attachmentsDir: string

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db)
    userId = randomUUID()
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`).run(
      userId,
      'u',
      'hash',
    )
    attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-attach-cleanup-'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(attachmentsDir, { recursive: true, force: true })
  })

  it('queues and removes conversation attachment files, leaving unrelated trees', async () => {
    const owned = seedConversationWithAttachment(db, userId)
    const unrelatedId = randomUUID()
    const ownedDir = writeAttachmentTree(attachmentsDir, userId, owned.attachmentId)
    const unrelatedDir = writeAttachmentTree(attachmentsDir, userId, unrelatedId)

    expect(deleteConversationForUser(db, userId, owned.conversationId)).toBe(true)
    expect(fs.existsSync(ownedDir)).toBe(true)
    expect(listAttachmentCleanup(db)).toEqual([
      { user_id: userId, attachment_id: owned.attachmentId },
    ])

    await drainAttachmentCleanup(db, attachmentsDir)

    expect(fs.existsSync(ownedDir)).toBe(false)
    expect(fs.existsSync(unrelatedDir)).toBe(true)
    expect(listAttachmentCleanup(db)).toEqual([])
  })

  it('leaves no queue row when conversation deletion rolls back', () => {
    const owned = seedConversationWithAttachment(db, userId)
    expect(() =>
      db.transaction(() => {
        expect(deleteConversationForUser(db, userId, owned.conversationId)).toBe(true)
        throw new Error('rollback')
      })(),
    ).toThrow('rollback')

    expect(listAttachmentCleanup(db)).toEqual([])
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE id = ?').get(owned.conversationId) as {
        count: number
      },
    ).toEqual({ count: 1 })
  })

  it('retries after a filesystem failure and treats a missing directory as success', async () => {
    const owned = seedConversationWithAttachment(db, userId)
    const ownedDir = writeAttachmentTree(attachmentsDir, userId, owned.attachmentId)
    deleteConversationForUser(db, userId, owned.conversationId)

    await expect(
      drainAttachmentCleanup(db, attachmentsDir, {
        removeTree: () => {
          throw new Error('eacces')
        },
      }),
    ).resolves.toBeUndefined()
    expect(fs.existsSync(ownedDir)).toBe(true)
    expect(listAttachmentCleanup(db)).toHaveLength(1)

    fs.rmSync(ownedDir, { recursive: true, force: true })
    await drainAttachmentCleanup(db, attachmentsDir)
    expect(listAttachmentCleanup(db)).toEqual([])
  })

  it('does not overlap drains', async () => {
    const first = seedConversationWithAttachment(db, userId)
    const second = seedConversationWithAttachment(db, userId)
    writeAttachmentTree(attachmentsDir, userId, first.attachmentId)
    writeAttachmentTree(attachmentsDir, userId, second.attachmentId)
    deleteConversationForUser(db, userId, first.conversationId)
    deleteConversationForUser(db, userId, second.conversationId)

    let current = 0
    let max = 0
    const removeTree = async () => {
      current += 1
      max = Math.max(max, current)
      await new Promise((resolve) => setTimeout(resolve, 20))
      current -= 1
    }

    await Promise.all([
      drainAttachmentCleanup(db, attachmentsDir, { removeTree }),
      drainAttachmentCleanup(db, attachmentsDir, { removeTree }),
    ])
    expect(max).toBe(1)
  })

  it('enqueues attachments when a bot delete removes its conversations', () => {
    const botId = randomUUID()
    db.prepare(
      `INSERT INTO bots (id, user_id, name, slug, role, soul, runtime, is_default)
       VALUES (?, ?, 'Grok', 'grok', '', '', 'grok', 0)`,
    ).run(botId, userId)
    const conversationId = randomUUID()
    const messageId = randomUUID()
    db.prepare(
      `INSERT INTO conversations (id, user_id, hermes_session_id, bot_id) VALUES (?, ?, ?, ?)`,
    ).run(conversationId, userId, randomUUID(), botId)
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', 'hi')`,
    ).run(messageId, conversationId)
    const attachmentId = insertStagedAttachment(db, {
      userId,
      contentType: 'image/jpeg',
      byteSize: 4,
      width: 1,
      height: 1,
      originalPath: 'original.jpg',
      thumbPath: 'thumb.jpg',
      visionPath: 'vision.jpg',
      orphanTtlHours: 24,
    })
    linkAttachmentsToMessage(db, userId, messageId, [attachmentId])

    expect(deleteBot(db, botId, userId)).toBe(true)
    expect(listAttachmentCleanup(db)).toEqual([{ user_id: userId, attachment_id: attachmentId }])
  })
})

describe('DELETE conversation attachment cleanup', () => {
  it('returns 204 and eventually removes files', async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-attach-http-'))
    const app = await createTestApp({ attachmentsDir, attachmentCleanupIntervalMs: 0 })
    await app.ready()
    try {
      const seeded = await seedTestUser(app, 'operator', 'password123')
      const { conversationId, attachmentId } = seedConversationWithAttachment(app.db, seeded.id)
      writeAttachmentTree(attachmentsDir, seeded.id, attachmentId)

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${seeded.token}` },
      })
      expect(deleted.statusCode).toBe(204)
      expect(fs.existsSync(attachmentRoot(attachmentsDir, seeded.id, attachmentId))).toBe(true)

      await drainAttachmentCleanup(app.db, attachmentsDir)
      expect(fs.existsSync(attachmentRoot(attachmentsDir, seeded.id, attachmentId))).toBe(false)
    } finally {
      await app.close()
      fs.rmSync(attachmentsDir, { recursive: true, force: true })
    }
  })
})
