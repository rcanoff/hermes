import type Database from 'better-sqlite3'
import type { ConversationSyncEntryPayload } from '../db/repos/chat-sync-events.js'
import type { ConversationRow } from '../db/repos/conversations.js'
import { modelDisplayName, type CuratedModelEntry } from './companion-models.js'

export function buildConversationSyncEntry(
  db: Database.Database,
  conversation: ConversationRow,
  catalog: CuratedModelEntry[],
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
    model: conversation.model,
    provider: conversation.provider,
    model_display: modelDisplayName(catalog, conversation.model, conversation.provider),
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    latest_message_id: latest?.id ?? null,
    latest_message_created_at: latest?.created_at ?? null,
    bot_id: conversation.bot_id,
    peer_bot_id: conversation.peer_bot_id,
    members: listConversationMembers(db, conversation.id),
    icon: conversation.icon,
    color: conversation.color,
    bot: conversation.kind === 'group' ? conversationBotRef(db, conversation.bot_id) : null,
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

function listConversationMembers(
  db: Database.Database,
  conversationId: string,
): Array<{ id: string; username: string }> {
  return db
    .prepare(`
      SELECT users.id AS id, users.username AS username
      FROM conversation_members
      INNER JOIN users ON users.id = conversation_members.user_id
      WHERE conversation_members.conversation_id = ?
      ORDER BY users.username ASC, users.id ASC
    `)
    .all(conversationId) as Array<{ id: string; username: string }>
}

function conversationBotRef(
  db: Database.Database,
  botId: string | null,
): { id: string; name: string; icon: string; color: string } | null {
  if (!botId) {
    return null
  }
  const bot = db
    .prepare(`SELECT id, name, icon, color FROM bots WHERE id = ?`)
    .get(botId) as { id: string; name: string; icon: string; color: string } | undefined
  return bot ?? null
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