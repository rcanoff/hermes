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

export function isLikelyOpenAiChatModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('chatgpt-') ||
    /^o\d/.test(normalized)
  )
}

export function shouldPreferHermesTitleGeneration(
  auxiliaryLlm?: AuxiliaryLlmConfig | null,
): boolean {
  if (!isAuxiliaryLlmConfigured(auxiliaryLlm)) {
    return true
  }
  if (auxiliaryLlm!.baseUrl.trim()) {
    return false
  }
  return !isLikelyOpenAiChatModel(auxiliaryLlm!.model)
}

async function completeTitleWithHermes(
  hermesClient: HermesClient,
  messages: HermesPromptMessage[],
): Promise<string> {
  return hermesClient.completeChat({
    hermesSessionId: COMPANION_TITLE_GENERATION_SESSION_KEY,
    messages,
  })
}

export async function generateConversationTitle(
  hermesClient: HermesClient,
  userMessageText: string,
  auxiliaryLlm?: AuxiliaryLlmConfig | null,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<string | null> {
  const messages = buildTitlePromptMessages(userMessageText)

  if (shouldPreferHermesTitleGeneration(auxiliaryLlm)) {
    try {
      const raw = await completeTitleWithHermes(hermesClient, messages)
      return sanitizeGeneratedTitle(raw)
    } catch (error) {
      log?.('title generation failed', {
        path: 'hermes',
        err: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  try {
    const raw = await completeAuxiliaryLlm(auxiliaryLlm!, messages)
    const title = sanitizeGeneratedTitle(raw)
    if (title) {
      return title
    }
    log?.('auxiliary title generation returned empty result; falling back to Hermes', {
      model: auxiliaryLlm!.model,
    })
  } catch (error) {
    log?.('auxiliary title generation failed; falling back to Hermes', {
      model: auxiliaryLlm!.model,
      err: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    const raw = await completeTitleWithHermes(hermesClient, messages)
    return sanitizeGeneratedTitle(raw)
  } catch (error) {
    log?.('title generation failed', {
      path: 'hermes_fallback',
      err: error instanceof Error ? error.message : String(error),
    })
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
  log?: (message: string, meta?: Record<string, unknown>) => void
}): Promise<void> {
  const title = await generateConversationTitle(
    input.hermesClient,
    input.userMessageText,
    input.auxiliaryLlm,
    input.log,
  )
  if (!title) {
    input.log?.('title generation produced no title', {
      conversationId: input.conversationId,
    })
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