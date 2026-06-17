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

  return {
    id: conversation.id,
    hermes_session_id: conversation.hermes_session_id,
    title: conversation.title,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    latest_message_id: latest?.id ?? null,
    latest_message_created_at: latest?.created_at ?? null,
  }
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