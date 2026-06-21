import type Database from 'better-sqlite3'
import {
  listAttachmentsForMessage,
  listAttachmentsForMessages,
  type AttachmentRow,
} from '../db/repos/message-attachments.js'
import type { MessageRow } from '../db/repos/messages.js'
import type { MessageProcess } from '../db/repos/process.js'

export interface AttachmentSummary {
  id: string
  content_type: string
  byte_size: number
  width: number | null
  height: number | null
  position: number
  _links: {
    self: { href: string }
    thumb: { href: string }
  }
}

export type MessageWithAttachments = MessageRow & {
  attachments?: AttachmentSummary[]
  process?: MessageProcess
}

export function serializeAttachment(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    content_type: row.content_type,
    byte_size: row.byte_size,
    width: row.width,
    height: row.height,
    position: row.position,
    _links: {
      self: { href: `/attachments/${row.id}` },
      thumb: { href: `/attachments/${row.id}?variant=thumb` },
    },
  }
}

export function enrichMessageWithAttachments(
  db: Database.Database,
  message: MessageRow,
): MessageWithAttachments {
  const rows = listAttachmentsForMessage(db, message.id)
  if (rows.length === 0) {
    return message
  }

  return {
    ...message,
    attachments: rows.map(serializeAttachment),
  }
}

export function enrichMessagesWithAttachments(
  messages: MessageRow[],
  attachmentMap: Map<string, AttachmentRow[]>,
): MessageWithAttachments[] {
  return messages.map((message) => {
    const rows = attachmentMap.get(message.id)
    if (!rows || rows.length === 0) {
      return message
    }

    return {
      ...message,
      attachments: rows.map(serializeAttachment),
    }
  })
}