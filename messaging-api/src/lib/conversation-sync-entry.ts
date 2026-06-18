import type Database from 'better-sqlite3'
import type { ConversationSyncEntryPayload } from '../db/repos/chat-sync-events.js'
import type { ConversationRow } from '../db/repos/conversations.js'

export function buildConversationSyncEntry(
  db: Database.Database,
  conversation: ConversationRow,
): ConversationSyncEntryPayload {
  const latest = db
    .prepare(`
      SELECT id, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `)
    .get(conversation.id) as { id: string; created_at: string } | undefined

  const entry: ConversationSyncEntryPayload = {
    id: conversation.id,
    hermes_session_id: conversation.hermes_session_id,
    kind: conversation.kind,
    title: conversation.title,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    latest_message_id: latest?.id ?? null,
    latest_message_created_at: latest?.created_at ?? null,
  }

  if (conversation.kind === 'job') {
    entry.hermes_job_id = conversation.hermes_job_id
    entry.schedule_display = conversation.schedule_display
    entry.job_enabled = conversation.job_enabled === 1
    entry.job_last_run_at = conversation.job_last_run_at
    entry.job_last_status = conversation.job_last_status
  }

  return entry
}

export function buildConversationMessageSyncSnapshot(conversation: ConversationRow) {
  return {
    id: conversation.id,
    hermes_session_id: conversation.hermes_session_id,
    title: conversation.title,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
  }
}