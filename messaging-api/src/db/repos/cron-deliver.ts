import type Database from 'better-sqlite3'
import { isCronSilentContent } from '../../lib/job-conversation.js'
import { emitConversationMessageUpsert } from '../../services/chat-sync-emitter.js'
import { findConversationByHermesJobId, touchConversationUpdatedAt } from './conversations.js'
import { insertMessage } from './messages.js'

export interface DeliverCronRunInput {
  hermesJobId: string
  content: string
  status?: 'ok' | 'error'
  runAt?: string
}

export type DeliverCronRunResult =
  | { kind: 'silent' }
  | { kind: 'delivered'; messageId: string }

export function deliverCronRun(
  db: Database.Database,
  input: DeliverCronRunInput,
): DeliverCronRunResult | null {
  const conversation = findConversationByHermesJobId(db, input.hermesJobId)
  if (!conversation) {
    return null
  }

  const runAt = input.runAt?.trim() || null
  const status = input.status === 'error' ? 'error' : 'ok'

  db.prepare(`
    UPDATE conversations
    SET job_last_run_at = COALESCE(?, datetime('now')),
        job_last_status = ?
    WHERE id = ?
  `).run(runAt, status, conversation.id)

  touchConversationUpdatedAt(db, conversation.id)

  if (isCronSilentContent(input.content)) {
    return { kind: 'silent' }
  }

  const trimmed = input.content.trim()
  if (!trimmed) {
    return { kind: 'silent' }
  }

  const messageId = insertMessage(db, {
    conversationId: conversation.id,
    role: 'assistant',
    content: trimmed,
  })

  const message = db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at
      FROM messages
      WHERE id = ?
    `)
    .get(messageId) as {
    id: string
    conversation_id: string
    role: 'user' | 'assistant'
    content: string
    created_at: string
  }

  emitConversationMessageUpsert(db, conversation.user_id, conversation.id, message)

  return { kind: 'delivered', messageId }
}