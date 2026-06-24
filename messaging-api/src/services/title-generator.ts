import type Database from 'better-sqlite3'
import {
  replaceConversationTitleIfEquals,
  updateConversationTitleIfNull,
} from '../db/repos/conversations.js'
import {
  completeAuxiliaryLlm,
  type AuxiliaryLlmConfig,
  isAuxiliaryLlmConfigured,
} from './auxiliary-llm-client.js'
import {
  buildTitleGenerationSessionKey,
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
const MAX_GENERATED_TITLE_WORDS = 6

export const OPENAI_TITLE_FALLBACK_MODEL = 'gpt-4o-mini'

const INVALID_TITLE_PATTERNS = [/you're at/i, /you are at/i]

export function buildTitlePromptMessages(userMessageText: string): HermesPromptMessage[] {
  return [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: userMessageText.slice(0, MAX_USER_MESSAGE_CHARS) },
  ]
}

export function isGrokComposerModel(model: string): boolean {
  return /^grok-composer-/i.test(model.trim())
}

export function resolveTitleGenerationLlm(
  auxiliaryLlm?: AuxiliaryLlmConfig | null,
): AuxiliaryLlmConfig | null {
  if (!isAuxiliaryLlmConfigured(auxiliaryLlm)) {
    return null
  }

  const config = auxiliaryLlm!
  if (!config.baseUrl.trim() && isGrokComposerModel(config.model)) {
    return {
      ...config,
      model: OPENAI_TITLE_FALLBACK_MODEL,
      baseUrl: '',
    }
  }

  return config
}

export function fallbackTitleFromUserMessage(text: string): string | null {
  const collapsed = text.trim().replace(/\s+/g, ' ')
  if (collapsed.length === 0) {
    return null
  }

  const words = collapsed.split(/\s+/).filter(Boolean).slice(0, MAX_GENERATED_TITLE_WORDS)
  const capped = words.join(' ').slice(0, MAX_GENERATED_TITLE_CHARS).trim()
  if (capped.length === 0) {
    return null
  }

  return capped.charAt(0).toUpperCase() + capped.slice(1)
}

export function sanitizeGeneratedTitle(
  raw: string,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): string | null {
  if (raw.includes('```')) {
    log?.('title generation rejected invalid title', { reason: 'markdown_fence' })
    return null
  }

  if (/\r|\n/.test(raw)) {
    log?.('title generation rejected invalid title', { reason: 'newline' })
    return null
  }

  if (/^\s*[\r\n]/.test(raw) || /\s{3,}/.test(raw)) {
    log?.('title generation rejected invalid title', { reason: 'whitespace' })
    return null
  }

  if (INVALID_TITLE_PATTERNS.some((pattern) => pattern.test(raw))) {
    log?.('title generation rejected invalid title', { reason: 'address_like' })
    return null
  }

  const collapsed = raw.trim().replace(/\s+/g, ' ')
  const unquoted = collapsed.replace(/^["'`]+|["'`]+$/g, '').trim()
  const capped = unquoted.slice(0, MAX_GENERATED_TITLE_CHARS).trim()
  if (capped.length === 0) {
    return null
  }

  const wordCount = capped.split(/\s+/).filter(Boolean).length
  if (wordCount > MAX_GENERATED_TITLE_WORDS) {
    log?.('title generation rejected invalid title', { reason: 'too_many_words', wordCount })
    return null
  }

  return capped
}

async function completeTitleWithHermes(
  hermesClient: HermesClient,
  conversationId: string,
  messages: HermesPromptMessage[],
): Promise<string> {
  return hermesClient.completeChat({
    hermesSessionId: buildTitleGenerationSessionKey(conversationId),
    messages,
  })
}

export async function generateConversationTitle(
  hermesClient: HermesClient,
  conversationId: string,
  userMessageText: string,
  auxiliaryLlm?: AuxiliaryLlmConfig | null,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<string | null> {
  const messages = buildTitlePromptMessages(userMessageText)
  const resolvedLlm = resolveTitleGenerationLlm(auxiliaryLlm)

  if (resolvedLlm) {
    try {
      const raw = await completeAuxiliaryLlm(resolvedLlm, messages)
      const title = sanitizeGeneratedTitle(raw, log)
      if (title) {
        return title
      }
      log?.('auxiliary title generation returned invalid title; falling back to Hermes', {
        model: resolvedLlm.model,
      })
    } catch (error) {
      log?.('auxiliary title generation failed; falling back to Hermes', {
        model: resolvedLlm.model,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    const raw = await completeTitleWithHermes(hermesClient, conversationId, messages)
    const title = sanitizeGeneratedTitle(raw, log)
    if (title) {
      return title
    }
    log?.('Hermes title generation returned invalid title; using user-message fallback', {
      conversationId,
    })
  } catch (error) {
    log?.('title generation failed', {
      path: 'hermes_fallback',
      err: error instanceof Error ? error.message : String(error),
    })
  }

  const fallback = fallbackTitleFromUserMessage(userMessageText)
  if (fallback) {
    log?.('title generation using user-message fallback', { conversationId })
    return fallback
  }

  return null
}

function publishConversationTitle(
  db: Database.Database,
  hub: StreamHub,
  userId: string,
  conversationId: string,
  title: string,
): void {
  emitAccountConversationUpsert(db, userId, conversationId)
  publishAccountConversationUpsert(hub, db, userId, conversationId)
  publishSessionTitle(hub, userId, conversationId, title)
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
  const provisionalTitle = fallbackTitleFromUserMessage(input.userMessageText)
  const title = await generateConversationTitle(
    input.hermesClient,
    input.conversationId,
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

  const currentTitle = input.db
    .prepare('SELECT title FROM conversations WHERE id = ?')
    .pluck()
    .get(input.conversationId) as string | null | undefined

  if (currentTitle === null || currentTitle === undefined) {
    const updated = updateConversationTitleIfNull(input.db, input.conversationId, title)
    if (updated) {
      publishConversationTitle(
        input.db,
        input.hub,
        input.userId,
        input.conversationId,
        title,
      )
    }
    return
  }

  if (
    provisionalTitle &&
    currentTitle === provisionalTitle &&
    title !== provisionalTitle
  ) {
    const upgraded = replaceConversationTitleIfEquals(
      input.db,
      input.conversationId,
      provisionalTitle,
      title,
    )
    if (upgraded) {
      publishConversationTitle(
        input.db,
        input.hub,
        input.userId,
        input.conversationId,
        title,
      )
    }
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
  const provisionalTitle = fallbackTitleFromUserMessage(input.userMessageText)
  if (provisionalTitle) {
    const updated = updateConversationTitleIfNull(
      input.db,
      input.conversationId,
      provisionalTitle,
    )
    if (updated) {
      publishConversationTitle(
        input.db,
        input.hub,
        input.userId,
        input.conversationId,
        provisionalTitle,
      )
    }
  }

  void generateAndSaveTitle(input).catch((error) => {
    input.log?.('title generation failed', {
      conversationId: input.conversationId,
      err: error instanceof Error ? error.message : String(error),
    })
  })
}