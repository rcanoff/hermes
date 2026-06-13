import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { updateConversationTitleIfNull } from '../db/repos/conversations.js'
import type { HermesClient } from './hermes-client.js'
import type { HermesPromptMessage } from './prompt-builder.js'
import type { StreamHub } from '../streams/hub.js'

const TITLE_SYSTEM_PROMPT =
  "Generate a short conversation title (max 6 words) from the user's message. Reply with only the title — no quotes, no punctuation."

const MAX_USER_MESSAGE_CHARS = 500
const MAX_GENERATED_TITLE_CHARS = 80

export function buildTitlePromptMessages(userMessageText: string): HermesPromptMessage[] {
  return [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: userMessageText.slice(0, MAX_USER_MESSAGE_CHARS) },
  ]
}

export function sanitizeGeneratedTitle(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, ' ')
  const unquoted = collapsed.replace(/^["'`]+|["'`]+$/g, '').trim()
  const capped = unquoted.slice(0, MAX_GENERATED_TITLE_CHARS).trim()
  return capped.length > 0 ? capped : null
}

export async function generateConversationTitle(
  hermesClient: HermesClient,
  userMessageText: string,
): Promise<string | null> {
  let raw = ''

  try {
    for await (const event of hermesClient.streamChat({
      hermesSessionId: randomUUID(),
      messages: buildTitlePromptMessages(userMessageText),
    })) {
      if (event.type === 'token' && event.text) {
        raw += event.text
      }
    }
  } catch {
    return null
  }

  return sanitizeGeneratedTitle(raw)
}

export async function generateAndSaveTitle(input: {
  db: Database.Database
  hermesClient: HermesClient
  hub: StreamHub
  conversationId: string
  userMessageText: string
}): Promise<void> {
  const title = await generateConversationTitle(input.hermesClient, input.userMessageText)
  if (!title) {
    return
  }

  const updated = updateConversationTitleIfNull(input.db, input.conversationId, title)
  if (updated) {
    input.hub.publish(input.conversationId, { event: 'title', data: { title } })
  }
}