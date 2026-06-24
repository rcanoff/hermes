import type Database from 'better-sqlite3'
import type { ConversationSyncEntryPayload } from '../db/repos/chat-sync-events.js'
import { getConversationForUser } from '../db/repos/conversations.js'
import { DEFAULT_COMPANION_MODELS, type CuratedModelEntry } from '../lib/companion-models.js'
import { buildConversationSyncEntry } from '../lib/conversation-sync-entry.js'
import type { MessageWithAttachments } from '../lib/attachment-serializer.js'
import type { StreamHub } from './hub.js'

export function publishMessageUpsert(
  hub: StreamHub,
  userId: string,
  conversationId: string,
  message: MessageWithAttachments,
  hermesSessionId?: string,
): void {
  hub.publishToUser(userId, {
    event: 'message_upsert',
    data: {
      conversationId,
      message,
      ...(hermesSessionId ? { hermes_session_id: hermesSessionId } : {}),
    },
  })
}

export function publishMessagesRewound(
  hub: StreamHub,
  userId: string,
  conversationId: string,
  removedMessageIds: string[],
  hermesSessionId: string,
): void {
  hub.publishToUser(userId, {
    event: 'messages_rewound',
    data: {
      conversationId,
      removed_message_ids: removedMessageIds,
      hermes_session_id: hermesSessionId,
    },
  })
}

export function publishConversationDeleted(
  hub: StreamHub,
  userId: string,
  conversationId: string,
): void {
  hub.publishToUser(userId, {
    event: 'conversation_deleted',
    data: { conversationId },
  })
}

export function publishConversationUpsert(
  hub: StreamHub,
  userId: string,
  conversation: ConversationSyncEntryPayload,
): void {
  hub.publishToUser(userId, {
    event: 'conversation_upsert',
    data: { conversation },
  })
}

export function publishAccountConversationUpsert(
  hub: StreamHub,
  db: Database.Database,
  userId: string,
  conversationId: string,
  catalog: CuratedModelEntry[] = DEFAULT_COMPANION_MODELS,
): void {
  const row = getConversationForUser(db, userId, conversationId)
  if (!row) {
    return
  }

  publishConversationUpsert(hub, userId, buildConversationSyncEntry(db, row, catalog))
}