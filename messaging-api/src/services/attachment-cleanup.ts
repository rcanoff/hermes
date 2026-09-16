import type Database from 'better-sqlite3'
import { removeAttachmentTree } from '../lib/attachment-storage.js'

const BATCH_SIZE = 50
const SAFE_ID = /^[A-Za-z0-9_-]+$/

export type AttachmentCleanupRow = {
  user_id: string
  attachment_id: string
}

export type RemoveAttachmentTree = (
  attachmentsDir: string,
  userId: string,
  attachmentId: string,
) => void | Promise<void>

const inflight = new WeakMap<Database.Database, Promise<void>>()

export function enqueueConversationAttachments(
  db: Database.Database,
  conversationId: string,
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO attachment_cleanup (user_id, attachment_id)
    SELECT user_id, id
    FROM message_attachments
    WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)
  `,
  ).run(conversationId)
}

export function listAttachmentCleanup(db: Database.Database): AttachmentCleanupRow[] {
  return db
    .prepare(
      `SELECT user_id, attachment_id FROM attachment_cleanup ORDER BY created_at ASC, attachment_id ASC`,
    )
    .all() as AttachmentCleanupRow[]
}

export function drainAttachmentCleanup(
  db: Database.Database,
  attachmentsDir: string,
  options?: {
    removeTree?: RemoveAttachmentTree
    log?: (message: string, meta?: Record<string, unknown>) => void
  },
): Promise<void> {
  const existing = inflight.get(db)
  if (existing) {
    return existing
  }

  const pending = runDrain(db, attachmentsDir, options).finally(() => {
    inflight.delete(db)
  })
  inflight.set(db, pending)
  return pending
}

async function runDrain(
  db: Database.Database,
  attachmentsDir: string,
  options?: {
    removeTree?: RemoveAttachmentTree
    log?: (message: string, meta?: Record<string, unknown>) => void
  },
): Promise<void> {
  const removeTree = options?.removeTree ?? removeAttachmentTree
  const ack = db.prepare(
    `DELETE FROM attachment_cleanup WHERE user_id = ? AND attachment_id = ?`,
  )

  while (true) {
    const rows = db
      .prepare(
        `SELECT user_id, attachment_id FROM attachment_cleanup ORDER BY created_at ASC, attachment_id ASC LIMIT ?`,
      )
      .all(BATCH_SIZE) as AttachmentCleanupRow[]
    if (rows.length === 0) {
      return
    }

    for (const row of rows) {
      if (!SAFE_ID.test(row.user_id) || !SAFE_ID.test(row.attachment_id)) {
        options?.log?.('skipping unsafe attachment cleanup id', row)
        ack.run(row.user_id, row.attachment_id)
        continue
      }

      try {
        await removeTree(attachmentsDir, row.user_id, row.attachment_id)
        ack.run(row.user_id, row.attachment_id)
      } catch (error) {
        options?.log?.('attachment cleanup failed', {
          ...row,
          err: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (rows.length < BATCH_SIZE) {
      return
    }
  }
}
