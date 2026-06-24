import type Database from 'better-sqlite3'
import { updateConversationTitleIfNull } from '../db/repos/conversations.js'
import {
  completeAuxiliaryLlm,
  type AuxiliaryLlmConfig,
  isAuxiliaryLlmConfigured,
} from './auxiliary-llm-client.js'
import {
  COMPANION_TITLE_GENERATION_SESSION_KEY,
  type HermesClient,
} from './hermes-client.js'
import type { HermesPromptMessage } from './prompt-builder.js'
import type { StreamHub } from '../streams/hub.js'
import { publishSessionTitle } from '../streams/run-event-publisher.js'
import { publishAccountConversationUpsert } from '../streams/sse-mutation-publisher.js'
import { emitAccountConversationUpsert } from './chat-sync-emitter.js'

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
  auxiliaryLlm?: AuxiliaryLlmConfig | null,
): Promise<string | null> {
  const messages = buildTitlePromptMessages(userMessageText)

  try {
    const raw = isAuxiliaryLlmConfigured(auxiliaryLlm)
      ? await completeAuxiliaryLlm(auxiliaryLlm!, messages)
      : await hermesClient.completeChat({
          hermesSessionId: COMPANION_TITLE_GENERATION_SESSION_KEY,
          messages,
        })
    return sanitizeGeneratedTitle(raw)
  } catch {
    return null
  }
}

export async function generateAndSaveTitle(input: {
  db: Database.Database
  hermesClient: HermesClient
  hub: StreamHub
  conversationId: string
  userId: string
  userMessageText: string
  originSessionId: string | null
  auxiliaryLlm?: AuxiliaryLlmConfig | null
}): Promise<void> {
  const title = await generateConversationTitle(
    input.hermesClient,
    input.userMessageText,
    input.auxiliaryLlm,
  )
  if (!title) {
    return
  }

  const updated = updateConversationTitleIfNull(input.db, input.conversationId, title)
  if (updated) {
    emitAccountConversationUpsert(input.db, input.userId, input.conversationId)
    publishAccountConversationUpsert(input.hub, input.db, input.userId, input.conversationId)
    publishSessionTitle(input.hub, input.userId, input.conversationId, title)
  }
}

export function scheduleTitleGeneration(input: {
  db: Database.Database
  hermesClient: HermesClient
  hub: StreamHub
  conversationId: string
  userId: string
  userMessageText: string
  originSessionId: string | null
  auxiliaryLlm?: AuxiliaryLlmConfig | null
  log?: (message: string, meta?: Record<string, unknown>) => void
}): void {
  void generateAndSaveTitle(input).catch((error) => {
    input.log?.('title generation failed', {
      conversationId: input.conversationId,
      err: error instanceof Error ? error.message : String(error),
    })
  })
}