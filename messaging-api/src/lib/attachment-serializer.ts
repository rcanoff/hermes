import type Database from 'better-sqlite3'
import { getBotsByIds, type BotRow } from '../db/repos/bots.js'
import { normalizeBotIcon } from './bot-appearance.js'
import {
  listAttachmentsForMessage,
  listAttachmentsForMessages,
  type AttachmentRow,
} from '../db/repos/message-attachments.js'
import type { MessageInput, MessageRow } from '../db/repos/messages.js'
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

export interface BotSummary {
  id: string
  name: string
  icon: string
  color: string
}

export type MessageWithAttachments = Omit<
  MessageRow,
  'from_bot_id' | 'to_bot_id' | 'delegation_id' | 'input'
> & {
  delegation_id?: string
  from_bot?: BotSummary
  to_bot?: BotSummary
  attachments?: AttachmentSummary[]
  process?: MessageProcess
  input?: MessageInput
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

export function toBotSummary(row: BotRow): BotSummary {
  return {
    id: row.id,
    name: row.name,
    icon: normalizeBotIcon(row.icon),
    color: row.color,
  }
}

type MessageBotIds = {
  from_bot_id?: string | null
  to_bot_id?: string | null
  from_bot?: BotSummary
  to_bot?: BotSummary
}

export function botSummariesForMessages(
  db: Database.Database,
  messages: MessageBotIds[],
): Map<string, BotSummary> {
  const ids: string[] = []
  for (const message of messages) {
    if (message.from_bot_id) {
      ids.push(message.from_bot_id)
    }
    if (message.to_bot_id) {
      ids.push(message.to_bot_id)
    }
    if (message.from_bot?.id) {
      ids.push(message.from_bot.id)
    }
    if (message.to_bot?.id) {
      ids.push(message.to_bot.id)
    }
  }

  const summaries = new Map<string, BotSummary>()
  for (const [id, row] of getBotsByIds(db, ids)) {
    summaries.set(id, toBotSummary(row))
  }
  return summaries
}

export function serializeMessage(
  message: MessageRow | MessageWithAttachments,
  bots: Map<string, BotSummary>,
  attachments?: AttachmentSummary[],
): MessageWithAttachments {
  const row = message as MessageRow & MessageWithAttachments
  const {
    from_bot_id: fromBotId,
    to_bot_id: toBotId,
    from_bot: existingFrom,
    to_bot: existingTo,
    attachments: _existingAttachments,
    delegation_id: delegationId,
    input,
    ...rest
  } = row
  const serialized: MessageWithAttachments = {
    ...rest,
    kind: row.kind ?? 'chat',
    ...(delegationId ? { delegation_id: delegationId } : {}),
    ...(input ? { input } : {}),
  }

  const fromBot = (fromBotId ? bots.get(fromBotId) : undefined) ?? existingFrom
  const toBot = (toBotId ? bots.get(toBotId) : undefined) ?? existingTo
  if (fromBot) {
    serialized.from_bot = fromBot
  }
  if (toBot) {
    serialized.to_bot = toBot
  }
  if (attachments && attachments.length > 0) {
    serialized.attachments = attachments
  }

  return serialized
}

export function enrichMessageWithAttachments(
  db: Database.Database,
  message: MessageRow,
): MessageWithAttachments {
  const rows = listAttachmentsForMessage(db, message.id)
  const bots = botSummariesForMessages(db, [message])
  return serializeMessage(message, bots, rows.map(serializeAttachment))
}

export function enrichMessagesWithAttachments(
  db: Database.Database,
  messages: Array<MessageRow | MessageWithAttachments>,
  attachmentMap: Map<string, AttachmentRow[]>,
): MessageWithAttachments[] {
  const bots = botSummariesForMessages(db, messages)
  return messages.map((message) => {
    const rows = attachmentMap.get(message.id)
    return serializeMessage(
      message,
      bots,
      rows && rows.length > 0 ? rows.map(serializeAttachment) : undefined,
    )
  })
}
