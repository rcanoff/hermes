import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { touchConversationUpdatedAt, type ListPageAnchors } from './conversations.js'

export const MESSAGE_KINDS = ['chat', 'bot_sent', 'bot_reply', 'pending_input'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

export const MESSAGE_INPUT_TYPES = ['permission', 'question'] as const
export type MessageInputType = (typeof MESSAGE_INPUT_TYPES)[number]

export const MESSAGE_INPUT_STATUSES = [
  'pending',
  'allowed',
  'denied',
  'answered',
  'cancelled',
] as const
export type MessageInputStatus = (typeof MESSAGE_INPUT_STATUSES)[number]

export interface MessageInput {
  id: string
  status: MessageInputStatus
  type: MessageInputType
  tool?: string
  preview?: string
}

export interface InsertMessageInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  kind?: MessageKind
  fromBotId?: string | null
  toBotId?: string | null
  delegationId?: string | null
  input?: MessageInput | null
  senderUserId?: string | null
  clientMessageId?: string | null
  mentionedBotId?: string | null
}

export interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  kind: MessageKind
  from_bot_id: string | null
  to_bot_id: string | null
  delegation_id: string | null
  input: MessageInput | null
  sender_user_id: string | null
  client_message_id: string | null
  mentioned_bot_id: string | null
  sequence: number | null
  sender_user: { id: string; username: string } | null
}

export interface MessagePage {
  messages: MessageRow[]
  hasOlder: boolean
  hasNewer: boolean
}

interface MessageCursorRow extends MessageRow {
  rowid: number
}

export const DUPLICATE_MESSAGE_WINDOW_SECONDS = 60

export const MESSAGE_COLUMNS = `
  id, conversation_id, role, content, created_at, kind, from_bot_id, to_bot_id, delegation_id, input_json,
  sender_user_id, client_message_id, mentioned_bot_id, sequence,
  (SELECT username FROM users WHERE users.id = messages.sender_user_id) AS sender_username
`

export interface MessageSqlRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  kind: MessageKind
  from_bot_id: string | null
  to_bot_id: string | null
  delegation_id: string | null
  input_json: string | null
  sender_user_id: string | null
  client_message_id: string | null
  mentioned_bot_id: string | null
  sequence: number | null
  sender_username: string | null
}

export function findRecentDuplicateUserMessage(
  db: Database.Database,
  conversationId: string,
  content: string,
  windowSeconds = DUPLICATE_MESSAGE_WINDOW_SECONDS,
): MessageRow | undefined {
  const row = db
    .prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE conversation_id = ?
        AND role = 'user'
        AND content = ?
        AND created_at >= datetime('now', '-' || ? || ' seconds')
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `)
    .get(conversationId, content, windowSeconds) as MessageSqlRow | undefined
  return row ? mapMessageRow(row) : undefined
}

export function allocateMessageSequence(db: Database.Database, conversationId: string): number {
  const row = db
    .prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM messages
      WHERE conversation_id = ?
    `)
    .get(conversationId) as { sequence: number }
  return row.sequence
}

export function findMessageByClientId(
  db: Database.Database,
  conversationId: string,
  senderUserId: string,
  clientMessageId: string,
): MessageRow | undefined {
  const row = db
    .prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE conversation_id = ? AND sender_user_id = ? AND client_message_id = ?
    `)
    .get(conversationId, senderUserId, clientMessageId) as MessageSqlRow | undefined
  return row ? mapMessageRow(row) : undefined
}

export function insertMessage(db: Database.Database, input: InsertMessageInput): string {
  const id = randomUUID()
  const sequence = allocateMessageSequence(db, input.conversationId)
  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, content, kind, from_bot_id, to_bot_id, delegation_id, input_json,
      sender_user_id, client_message_id, mentioned_bot_id, sequence
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.conversationId,
    input.role,
    input.content,
    input.kind ?? 'chat',
    input.fromBotId ?? null,
    input.toBotId ?? null,
    input.delegationId ?? null,
    serializeMessageInput(input.input),
    input.senderUserId ?? null,
    input.clientMessageId ?? null,
    input.mentionedBotId ?? null,
    sequence,
  )
  touchConversationUpdatedAt(db, input.conversationId)
  return id
}

export function listMessages(db: Database.Database, conversationId: string): MessageRow[] {
  return (
    db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(conversationId) as MessageSqlRow[]
  ).map(mapMessageRow)
}

export function listRecentMessages(
  db: Database.Database,
  conversationId: string,
  limit: number,
): MessageRow[] {
  if (limit < 1) {
    return []
  }

  const rows = db
    .prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(conversationId, limit) as MessageSqlRow[]

  return rows.map(mapMessageRow).reverse()
}

export function listMessagesPage(
  db: Database.Database,
  conversationId: string,
  limit: number,
  anchors: ListPageAnchors = {},
): MessagePage | null {
  if (anchors.before) {
    const cursor = getMessageCursor(db, conversationId, anchors.before)
    if (!cursor) {
      return null
    }

    const messages = db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages
        WHERE conversation_id = ?
          AND (
            created_at < ?
            OR (created_at = ? AND rowid < ?)
          )
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(conversationId, cursor.created_at, cursor.created_at, cursor.rowid, limit) as MessageSqlRow[]

    messages.reverse()
    return buildMessagePage(db, conversationId, messages.map(mapMessageRow))
  }

  if (anchors.after) {
    const cursor = getMessageCursor(db, conversationId, anchors.after)
    if (!cursor) {
      return null
    }

    const messages = db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages
        WHERE conversation_id = ?
          AND (
            created_at > ?
            OR (created_at = ? AND rowid > ?)
          )
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `)
      .all(conversationId, cursor.created_at, cursor.created_at, cursor.rowid, limit) as MessageSqlRow[]

    return buildMessagePage(db, conversationId, messages.map(mapMessageRow))
  }

  const messages = db
    .prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(conversationId, limit) as MessageSqlRow[]

  messages.reverse()
  return buildMessagePage(db, conversationId, messages.map(mapMessageRow))
}

export function getMessage(
  db: Database.Database,
  conversationId: string,
  messageId: string,
): MessageRow | undefined {
  const row = db
    .prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE conversation_id = ? AND id = ?
    `)
    .get(conversationId, messageId) as MessageSqlRow | undefined
  return row ? mapMessageRow(row) : undefined
}

export function getMessageById(db: Database.Database, messageId: string): MessageRow | undefined {
  const row = db
    .prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE id = ?
    `)
    .get(messageId) as MessageSqlRow | undefined
  return row ? mapMessageRow(row) : undefined
}

export function listMessagesByInputId(db: Database.Database, inputId: string): MessageRow[] {
  return (
    db
      .prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages
        WHERE json_extract(input_json, '$.id') = ?
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(inputId) as MessageSqlRow[]
  ).map(mapMessageRow)
}

export function updateMessageInput(
  db: Database.Database,
  messageId: string,
  input: MessageInput,
): MessageRow | undefined {
  db.prepare(`
    UPDATE messages
    SET input_json = ?
    WHERE id = ?
  `).run(JSON.stringify(input), messageId)

  const row = getMessageById(db, messageId)
  if (row) {
    touchConversationUpdatedAt(db, row.conversation_id)
  }
  return row
}

export function updateMessageContent(
  db: Database.Database,
  conversationId: string,
  messageId: string,
  content: string,
): MessageRow | undefined {
  db.prepare(`
    UPDATE messages
    SET content = ?
    WHERE conversation_id = ? AND id = ? AND role = 'user'
  `).run(content, conversationId, messageId)

  touchConversationUpdatedAt(db, conversationId)
  return getMessage(db, conversationId, messageId)
}

export function deleteMessage(db: Database.Database, conversationId: string, messageId: string): void {
  db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ? AND id = ?
  `).run(conversationId, messageId)
}

function getMessageCursor(
  db: Database.Database,
  conversationId: string,
  messageId: string,
): MessageCursorRow | undefined {
  const row = db
    .prepare(`
      SELECT rowid, ${MESSAGE_COLUMNS}
      FROM messages
      WHERE conversation_id = ? AND id = ?
    `)
    .get(conversationId, messageId) as (MessageSqlRow & { rowid: number }) | undefined
  if (!row) {
    return undefined
  }
  return { ...mapMessageRow(row), rowid: row.rowid }
}

export function mapMessageRow(row: MessageSqlRow): MessageRow {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    kind: row.kind,
    from_bot_id: row.from_bot_id,
    to_bot_id: row.to_bot_id,
    delegation_id: row.delegation_id,
    input: parseMessageInput(row.input_json),
    sender_user_id: row.sender_user_id ?? null,
    client_message_id: row.client_message_id ?? null,
    mentioned_bot_id: row.mentioned_bot_id ?? null,
    sequence: row.sequence ?? null,
    sender_user:
      row.sender_user_id && row.sender_username
        ? { id: row.sender_user_id, username: row.sender_username }
        : null,
  }
}

function serializeMessageInput(input: MessageInput | null | undefined): string | null {
  if (!input) {
    return null
  }
  return JSON.stringify(input)
}

function parseMessageInput(raw: string | null): MessageInput | null {
  if (!raw) {
    return null
  }

  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)) {
      return null
    }
    if (typeof value.id !== 'string' || !value.id) {
      return null
    }
    if (!isMessageInputStatus(value.status) || !isMessageInputType(value.type)) {
      return null
    }

    const input: MessageInput = {
      id: value.id,
      status: value.status,
      type: value.type,
    }
    if (typeof value.tool === 'string' && value.tool) {
      input.tool = value.tool
    }
    if (typeof value.preview === 'string' && value.preview) {
      input.preview = value.preview
    }
    return input
  } catch {
    return null
  }
}

function isMessageInputStatus(value: unknown): value is MessageInputStatus {
  return MESSAGE_INPUT_STATUSES.includes(value as MessageInputStatus)
}

function isMessageInputType(value: unknown): value is MessageInputType {
  return MESSAGE_INPUT_TYPES.includes(value as MessageInputType)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildMessagePage(
  db: Database.Database,
  conversationId: string,
  messages: MessageRow[],
): MessagePage {
  if (messages.length === 0) {
    return {
      messages,
      hasOlder: false,
      hasNewer: false,
    }
  }

  const first = getMessageCursor(db, conversationId, messages[0]!.id)!
  const last = getMessageCursor(db, conversationId, messages[messages.length - 1]!.id)!

  const hasOlder = db
    .prepare(`
      SELECT 1
      FROM messages
      WHERE conversation_id = ?
        AND (
          created_at < ?
          OR (created_at = ? AND rowid < ?)
        )
      LIMIT 1
    `)
    .get(conversationId, first.created_at, first.created_at, first.rowid) as { 1: number } | undefined

  const hasNewer = db
    .prepare(`
      SELECT 1
      FROM messages
      WHERE conversation_id = ?
        AND (
          created_at > ?
          OR (created_at = ? AND rowid > ?)
        )
      LIMIT 1
    `)
    .get(conversationId, last.created_at, last.created_at, last.rowid) as { 1: number } | undefined

  return {
    messages,
    hasOlder: hasOlder !== undefined,
    hasNewer: hasNewer !== undefined,
  }
}
