import type { StreamHub } from './hub.js'
import type { MessageWithAttachments } from '../lib/attachment-serializer.js'

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