import fs from 'node:fs/promises'
import type { AttachmentRow } from '../db/repos/message-attachments.js'
import type { MessageKind } from '../db/repos/messages.js'
import { resolveAttachmentFile } from '../lib/attachment-storage.js'

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HistoryBotRef {
  id: string
  name: string
}

export interface HistoryMessage extends TranscriptMessage {
  attachments?: AttachmentRow[]
  kind?: MessageKind
  from_bot_id?: string | null
  to_bot_id?: string | null
  from_bot?: HistoryBotRef | null
  to_bot?: HistoryBotRef | null
}

export interface HermesTextPart {
  type: 'text'
  text: string
}

export interface HermesImageUrlPart {
  type: 'image_url'
  image_url: { url: string }
}

export type HermesContentPart = HermesTextPart | HermesImageUrlPart

export interface HermesPromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | HermesContentPart[]
}

export interface BuildHermesMessagesOptions {
  bootstrapPrompt?: string | null
  companionUsername?: string
  rosterPrompt?: string | null
  attachmentsDir?: string
  userId?: string
  visionHistoryMaxBytes?: number
  currentBotId?: string | null
}

const USERNAME_SAFETY_TEMPLATE =
  'The authenticated companion user for this conversation is "{username}". Use this username for companion MCP data calls unless the user explicitly asks about someone else.'

interface PendingVisionImage {
  messageIndex: number
  attachmentIndex: number
  absolutePath: string
  byteSize: number
}

export function buildHermesSystemPrompt(options?: BuildHermesMessagesOptions): string {
  const parts: string[] = []
  const bootstrap = options?.bootstrapPrompt?.trim()

  if (bootstrap) {
    parts.push(bootstrap)
  }

  const username = options?.companionUsername?.trim()
  if (username && !bootstrap?.includes(username)) {
    parts.push(USERNAME_SAFETY_TEMPLATE.replace('{username}', username))
  }

  const head = parts.join(' ')
  const roster = options?.rosterPrompt?.trim()
  if (!roster) {
    return head
  }

  return head ? `${head}\n\n${roster}` : roster
}

export async function buildHermesMessages(
  history: HistoryMessage[],
  options?: BuildHermesMessagesOptions,
): Promise<HermesPromptMessage[]> {
  const systemContent = buildHermesSystemPrompt(options)
  const messages: HermesPromptMessage[] = []

  if (systemContent) {
    messages.push({ role: 'system', content: systemContent })
  }

  const includedVisionKeys = await selectVisionImages(history, options)
  const transcript = await Promise.all(
    history.map(async (message, messageIndex) => {
      const mapped = mapDelegationForHermes(message, options?.currentBotId)
      if (mapped.role !== 'user' || !message.attachments || message.attachments.length === 0) {
        return mapped satisfies HermesPromptMessage
      }

      const parts: HermesContentPart[] = []
      const caption = mapped.content.trim()
      if (caption) {
        parts.push({ type: 'text', text: caption })
      }

      for (let attachmentIndex = 0; attachmentIndex < message.attachments.length; attachmentIndex += 1) {
        const key = visionKey(messageIndex, attachmentIndex)
        if (!includedVisionKeys.has(key)) {
          continue
        }

        const attachment = message.attachments[attachmentIndex]
        const absolutePath = resolveVisionPath(options, attachment)
        const bytes = await fs.readFile(absolutePath)
        parts.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` },
        })
      }

      if (parts.length === 0) {
        return mapped satisfies HermesPromptMessage
      }

      return {
        role: mapped.role,
        content: parts,
      } satisfies HermesPromptMessage
    }),
  )

  return [...messages, ...transcript]
}

async function selectVisionImages(
  history: HistoryMessage[],
  options?: BuildHermesMessagesOptions,
): Promise<Set<string>> {
  const maxBytes = options?.visionHistoryMaxBytes ?? 8_388_608
  const pending: PendingVisionImage[] = []

  for (let messageIndex = 0; messageIndex < history.length; messageIndex += 1) {
    const message = history[messageIndex]
    if (message.role !== 'user' || !message.attachments || message.attachments.length === 0) {
      continue
    }

    for (let attachmentIndex = 0; attachmentIndex < message.attachments.length; attachmentIndex += 1) {
      const attachment = message.attachments[attachmentIndex]
      const absolutePath = resolveVisionPath(options, attachment)
      let byteSize = 0
      try {
        byteSize = (await fs.stat(absolutePath)).size
      } catch {
        continue
      }

      pending.push({ messageIndex, attachmentIndex, absolutePath, byteSize })
    }
  }

  let total = pending.reduce((sum, item) => sum + item.byteSize, 0)
  const excluded = new Set<string>()
  let cursor = 0
  while (total > maxBytes && cursor < pending.length) {
    const item = pending[cursor]
    excluded.add(visionKey(item.messageIndex, item.attachmentIndex))
    total -= item.byteSize
    cursor += 1
  }

  const included = new Set<string>()
  for (const item of pending) {
    const key = visionKey(item.messageIndex, item.attachmentIndex)
    if (!excluded.has(key)) {
      included.add(key)
    }
  }

  return included
}

export function mapDelegationForHermes(
  message: HistoryMessage,
  currentBotId?: string | null,
): TranscriptMessage {
  const kind = message.kind ?? 'chat'
  if (kind === 'chat') {
    return { role: message.role, content: message.content }
  }

  const fromId = message.from_bot?.id ?? message.from_bot_id ?? null
  const fromName = message.from_bot?.name?.trim() || 'Teammate'
  const toName = message.to_bot?.name?.trim() || 'teammate'

  if (kind === 'bot_sent') {
    if (fromId && currentBotId && fromId !== currentBotId) {
      return {
        role: 'user',
        content: `${fromName} (teammate) asks: ${message.content}`,
      }
    }

    return {
      role: 'assistant',
      content: `You messaged ${toName}: ${message.content}`,
    }
  }

  if (kind === 'bot_reply') {
    return {
      role: 'assistant',
      content: `${fromName} replied: ${message.content}`,
    }
  }

  return { role: message.role, content: message.content }
}

function visionKey(messageIndex: number, attachmentIndex: number): string {
  return `${messageIndex}:${attachmentIndex}`
}

function resolveVisionPath(
  options: BuildHermesMessagesOptions | undefined,
  attachment: AttachmentRow,
): string {
  const attachmentsDir = options?.attachmentsDir ?? '/opt/data/attachments'
  const userId = options?.userId ?? attachment.user_id
  return resolveAttachmentFile(attachmentsDir, userId, attachment.id, attachment.vision_path)
}