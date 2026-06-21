import fs from 'node:fs/promises'
import type { AttachmentRow } from '../db/repos/message-attachments.js'
import { resolveAttachmentFile } from '../lib/attachment-storage.js'

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HistoryMessage extends TranscriptMessage {
  attachments?: AttachmentRow[]
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
  attachmentsDir?: string
  userId?: string
  visionHistoryMaxBytes?: number
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

  return parts.join(' ')
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
      if (message.role !== 'user' || !message.attachments || message.attachments.length === 0) {
        return {
          role: message.role,
          content: message.content,
        } satisfies HermesPromptMessage
      }

      const parts: HermesContentPart[] = []
      const caption = message.content.trim()
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
        return {
          role: message.role,
          content: message.content,
        } satisfies HermesPromptMessage
      }

      return {
        role: message.role,
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