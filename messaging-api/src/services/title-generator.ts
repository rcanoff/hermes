import type Database from 'better-sqlite3'
import {
  replaceConversationTitleIfEquals,
  updateConversationTitleIfNull,
} from '../db/repos/conversations.js'
import type { TitleGenerationConfig } from '../config.js'
import { completeHermesAuxiliary } from './hermes-auxiliary-client.js'
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
  "Summarize the user's message as a short conversation title (max 6 words). Do not copy the message verbatim — rephrase the topic (e.g. \"hello\" → \"Greeting\", not \"Hello\"). Reply with only the title — no quotes, no punctuation."

const MAX_USER_MESSAGE_CHARS = 500
const MAX_GENERATED_TITLE_CHARS = 80
const MAX_GENERATED_TITLE_WORDS = 6

const INVALID_TITLE_PATTERNS = [
  /you're at/i,
  /you are at/i,
  /\bmap\s*ty\b/i,
  /stale map block/i,
]

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi
const MARKDOWN_FENCE_PATTERN = /```[\s\S]*?```|```/g

const TITLE_FILLER_PREFIXES = [
  /^(here are|here's|here is|sure[,!]?|of course[,!]?|certainly[,!]?|yes[,!]?)\s+/i,
]

const QUESTION_STARTERS =
  /^(what|where|how|why|when|who|can we|can you|could we|could you|do you|does|is there|are there)\s+/i

const TRAILING_REQUEST_CLAUSES =
  /\b(give me|show me|send me|list of|a list of|please|thanks|thank you)\b.*$/i

const RENTAL_TOPIC_PATTERN =
  /\b(apartment|apartments|flat|flats|rent|rental|rentals|miete|housing|lease)\b/i

const WEBSITE_TOPIC_PATTERN = /\b(website|websites|site|sites|link|links)\b/i

function capitalizeWords(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function limitTitleWords(text: string, maxWords = MAX_GENERATED_TITLE_WORDS): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ')
}

export function extractTitleCandidateFromRaw(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  for (const line of lines) {
    const withoutUrls = line.replace(URL_PATTERN, '').trim()
    if (!withoutUrls) {
      continue
    }

    const withoutFences = withoutUrls.replace(MARKDOWN_FENCE_PATTERN, '').trim()
    if (!withoutFences) {
      continue
    }

    return withoutFences.replace(/\s+/g, ' ')
  }

  return raw
    .replace(URL_PATTERN, '')
    .replace(MARKDOWN_FENCE_PATTERN, '')
    .trim()
    .replace(/\s+/g, ' ')
}

export function condenseToTitleWords(
  text: string,
  maxWords: number = MAX_GENERATED_TITLE_WORDS,
): string {
  let cleaned = text.trim().replace(/\s+/g, ' ')
  if (cleaned.length === 0) {
    return ''
  }

  for (const prefix of TITLE_FILLER_PREFIXES) {
    cleaned = cleaned.replace(prefix, '')
  }

  cleaned = cleaned.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  cleaned = cleaned.replace(/[:;,.!?]+$/g, '').trim()

  const inPlaceMatch = cleaned.match(
    /\b(?:for\s+)?(?:long[- ]term\s+)?(?:rentals?|apartments?|flats?|housing|leases?)\b.*?\bin\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]{1,30})\b/i,
  )
  if (inPlaceMatch) {
    const place = capitalizeWords(inPlaceMatch[1].trim())
    if (RENTAL_TOPIC_PATTERN.test(cleaned)) {
      if (WEBSITE_TOPIC_PATTERN.test(cleaned)) {
        return limitTitleWords(`${place} apartment rental websites`, maxWords)
      }
      return limitTitleWords(`${place} long term rentals`, maxWords)
    }
    return limitTitleWords(`${place} rentals`, maxWords)
  }

  const trailingPlaceMatch = cleaned.match(/\bin\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]{1,30})\s*$/i)
  if (trailingPlaceMatch && RENTAL_TOPIC_PATTERN.test(cleaned)) {
    const place = capitalizeWords(trailingPlaceMatch[1].trim())
    if (WEBSITE_TOPIC_PATTERN.test(cleaned)) {
      return limitTitleWords(`${place} apartment rental websites`, maxWords)
    }
    return limitTitleWords(`${place} long term rentals`, maxWords)
  }

  cleaned = cleaned.replace(QUESTION_STARTERS, '').trim()

  return limitTitleWords(cleaned, maxWords)
}

function buildCityQuestionFallbackTitle(cleaned: string, city: string): string {
  const capitalizedCity = capitalizeWords(city)
  if (RENTAL_TOPIC_PATTERN.test(cleaned)) {
    if (WEBSITE_TOPIC_PATTERN.test(cleaned)) {
      return limitTitleWords(`${capitalizedCity} apartment rental websites`)
    }
    return limitTitleWords(`${capitalizedCity} long term rentals`)
  }

  const topicPart = cleaned
    .replace(new RegExp(`\\bin\\s+${city}\\s*$`, 'i'), '')
    .replace(QUESTION_STARTERS, '')
    .trim()
  const condensed = condenseToTitleWords(topicPart)
  if (!condensed) {
    return capitalizedCity
  }

  return limitTitleWords(`${capitalizedCity} ${condensed}`)
}

export function buildTitlePromptMessages(userMessageText: string): HermesPromptMessage[] {
  return [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: userMessageText.slice(0, MAX_USER_MESSAGE_CHARS) },
  ]
}

export function fallbackTitleFromUserMessage(text: string): string | null {
  let cleaned = text.trim().replace(/\s+/g, ' ')
  if (cleaned.length === 0) {
    return null
  }

  const questionIndex = cleaned.indexOf('?')
  if (questionIndex >= 0) {
    cleaned = cleaned.slice(0, questionIndex).trim()
  }

  cleaned = cleaned.replace(TRAILING_REQUEST_CLAUSES, '').trim()
  if (cleaned.length === 0) {
    return null
  }

  const isQuestionLike = QUESTION_STARTERS.test(cleaned)
  const inCityMatch = cleaned.match(/\bin\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]{1,30})\s*$/i)
  if (isQuestionLike && inCityMatch) {
    const cityTitle = buildCityQuestionFallbackTitle(cleaned, inCityMatch[1].trim())
    if (cityTitle.length > 0) {
      return cityTitle
    }
  }

  const condensed = condenseToTitleWords(cleaned)
  if (condensed.length === 0) {
    return null
  }

  const capped = condensed.slice(0, MAX_GENERATED_TITLE_CHARS).trim()
  if (capped.length === 0) {
    return null
  }

  return capped.charAt(0).toUpperCase() + capped.slice(1)
}

export function sanitizeGeneratedTitle(
  raw: string,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): string | null {
  const extracted = extractTitleCandidateFromRaw(raw)
  if (extracted.length === 0) {
    return null
  }

  const condensed = condenseToTitleWords(extracted)
  if (condensed.length === 0) {
    return null
  }

  if (INVALID_TITLE_PATTERNS.some((pattern) => pattern.test(condensed))) {
    log?.('title generation rejected invalid title', { reason: 'address_like' })
    return null
  }

  const unquoted = condensed.replace(/^["'`]+|["'`]+$/g, '').trim()
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

function resolveTitleGeneration(
  titleGeneration?: TitleGenerationConfig | null,
): TitleGenerationConfig {
  return (
    titleGeneration ?? {
      bridgeUrl: '',
      bridgeApiKey: '',
      providers: [],
      timeoutMs: 30_000,
    }
  )
}

export async function generateTitleFromLlm(
  hermesClient: HermesClient,
  conversationId: string,
  userMessageText: string,
  titleGeneration?: TitleGenerationConfig | null,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<string | null> {
  const messages = buildTitlePromptMessages(userMessageText)
  const resolved = resolveTitleGeneration(titleGeneration)

  if (resolved.bridgeUrl) {
    for (const provider of resolved.providers) {
      try {
        const raw = await completeHermesAuxiliary(
          resolved.bridgeUrl,
          resolved.bridgeApiKey,
          {
            provider: provider.provider,
            model: provider.model,
            messages,
            timeoutMs: resolved.timeoutMs,
          },
        )
        const title = sanitizeGeneratedTitle(raw, log)
        if (title) {
          return title
        }
        log?.('title provider returned invalid title; trying next', {
          provider: provider.provider,
          model: provider.model,
        })
      } catch (error) {
        log?.('title provider failed; trying next', {
          provider: provider.provider,
          model: provider.model,
          err: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  try {
    const raw = await completeTitleWithHermes(hermesClient, conversationId, messages)
    const title = sanitizeGeneratedTitle(raw, log)
    if (title) {
      return title
    }
    log?.('Hermes title generation returned invalid title', { conversationId })
  } catch (error) {
    log?.('title generation failed', {
      path: 'hermes_fallback',
      err: error instanceof Error ? error.message : String(error),
    })
  }

  return null
}

export async function generateConversationTitle(
  hermesClient: HermesClient,
  conversationId: string,
  userMessageText: string,
  titleGeneration?: TitleGenerationConfig | null,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<string | null> {
  const llmTitle = await generateTitleFromLlm(
    hermesClient,
    conversationId,
    userMessageText,
    titleGeneration,
    log,
  )
  if (llmTitle) {
    return llmTitle
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
  titleGeneration?: TitleGenerationConfig | null
  log?: (message: string, meta?: Record<string, unknown>) => void
}): Promise<void> {
  const provisionalTitle = fallbackTitleFromUserMessage(input.userMessageText)
  const title = await generateTitleFromLlm(
    input.hermesClient,
    input.conversationId,
    input.userMessageText,
    input.titleGeneration,
    input.log,
  )

  const currentTitle = input.db
    .prepare('SELECT title FROM conversations WHERE id = ?')
    .pluck()
    .get(input.conversationId) as string | null | undefined

  if (!title) {
    const improvedFallback = fallbackTitleFromUserMessage(input.userMessageText)
    if (
      improvedFallback &&
      provisionalTitle &&
      improvedFallback !== provisionalTitle &&
      currentTitle === provisionalTitle
    ) {
      const upgraded = replaceConversationTitleIfEquals(
        input.db,
        input.conversationId,
        provisionalTitle,
        improvedFallback,
      )
      if (upgraded) {
        publishConversationTitle(
          input.db,
          input.hub,
          input.userId,
          input.conversationId,
          improvedFallback,
        )
      }
    }

    input.log?.('title generation produced no title', {
      conversationId: input.conversationId,
    })
    return
  }

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
  titleGeneration?: TitleGenerationConfig | null
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