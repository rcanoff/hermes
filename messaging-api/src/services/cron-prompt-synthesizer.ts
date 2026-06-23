import type Database from 'better-sqlite3'
import { listRecentMessages, type MessageRow } from '../db/repos/messages.js'
import {
  type CompanionCronJobKind,
  inferCompanionCronJobKindHeuristic,
  isExplicitHomeAssistantDigestJob,
} from '../lib/companion-cron-prompt.js'
import type { HermesCronJob } from '../lib/hermes-cron-jobs.js'
import {
  completeAuxiliaryLlm,
  type AuxiliaryLlmConfig,
  isAuxiliaryLlmConfigured,
} from './auxiliary-llm-client.js'
import {
  COMPANION_CRON_PROMPT_SYNTHESIS_SESSION_KEY,
  type HermesClient,
} from './hermes-client.js'
import type { HermesPromptMessage } from './prompt-builder.js'

export const DEFAULT_CRON_PROMPT_SYNTHESIS_MODEL = 'gpt-5.4'
export const DEFAULT_CRON_PROMPT_MESSAGE_LIMIT = 15
export const MAX_CRON_PROMPT_MESSAGE_CHARS = 2_000
export const MAX_CRON_PROMPT_EXCERPT_CHARS = 16_000
export const MAX_SYNTHESIZED_CRON_PROMPT_CHARS = 8_000
export const CRON_PROMPT_SYNTHESIS_MAX_COMPLETION_TOKENS = 4_096

export const CRON_PROMPT_CLASSIFICATION_SYSTEM = `You classify and write Hermes cron job prompts for Companion App jobs.

At fire time the cron agent only sees your prompt. Its final response is posted verbatim to the user.

Step 1 — classify the job kind:
- reminder: user asked to be reminded later; one-shot schedule; follow-up on a prior topic. Mentioning Home Assistant as the reminder subject is still a reminder, NOT ha_digest.
- ha_digest: recurring scheduled Home Assistant logbook digest for yesterday (not a one-shot reminder about HA).
- monitoring: recurring watch/check job that should respond [SILENT] when nothing new.

Step 2 — write the prompt:
- reminder: make the cron run output a useful, self-contained reminder message. Resolve this/that/it. Copy links, prices, map blocks, and concrete steps already in the conversation. Do not invent URLs or numbers.
- monitoring: describe the watch task, sources, output format, and [SILENT] when nothing to report.
- ha_digest: set prompt to an empty string (the server applies a canonical digest template).

Reminder prompt shape (adapt wording; keep the embedded output message concrete):

Scheduled reminder. Your entire response must be the user-facing reminder message only — no tool calls, no preamble, no narration.

Output exactly:

Reminder: <action>

<helpful context from the conversation — links, prices, map blocks, brief recap>

Never use send / notify / deliver / message the user wording.

Reply with ONLY JSON (no markdown fences):
{"kind":"reminder|ha_digest|monitoring","prompt":"..."}`

export interface ClassifiedCronPrompt {
  kind: CompanionCronJobKind
  prompt: string | null
}

export interface CronPromptSynthesisInput {
  job: Pick<HermesCronJob, 'name' | 'prompt' | 'schedule_display'>
  messages: MessageRow[]
  userTriggerMessage?: string | null
}

export function findUserTriggerMessage(messages: MessageRow[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.content.trim()) {
      return message.content.trim()
    }
  }

  return null
}

export function shouldSynthesizeCompanionCronPrompt(job: Pick<HermesCronJob, 'name' | 'prompt' | 'schedule_display'>): boolean {
  return !isExplicitHomeAssistantDigestJob({
    name: job.name,
    prompt: job.prompt,
    schedule_display: job.schedule_display,
  })
}

export function formatConversationExcerpt(messages: MessageRow[]): string {
  const lines: string[] = []
  let totalChars = 0

  for (const message of messages) {
    const content = message.content.trim().replace(/\s+/g, ' ')
    if (!content) {
      continue
    }

    const clipped = content.slice(0, MAX_CRON_PROMPT_MESSAGE_CHARS)
    const line = `${message.role}: ${clipped}`
    if (totalChars + line.length > MAX_CRON_PROMPT_EXCERPT_CHARS) {
      break
    }

    lines.push(line)
    totalChars += line.length
  }

  return lines.join('\n')
}

export function buildCronPromptSynthesisMessages(input: CronPromptSynthesisInput): HermesPromptMessage[] {
  const excerpt = formatConversationExcerpt(input.messages)
  const schedule = input.job.schedule_display?.trim() || 'scheduled'
  const draftPrompt = input.job.prompt?.trim()
  const userTrigger = input.userTriggerMessage?.trim()

  const parts = [
    `Job name: ${input.job.name.trim()}`,
    `Schedule: ${schedule}`,
  ]

  if (userTrigger) {
    parts.push(`User reminder request:\n${userTrigger}`)
  }

  if (draftPrompt) {
    parts.push(
      `Draft prompt from the creating agent (classify the job, then rewrite into a useful self-contained fire-time prompt when kind is reminder):\n${draftPrompt}`,
    )
  }

  if (excerpt) {
    parts.push(`Recent conversation:\n${excerpt}`)
  } else {
    parts.push('Recent conversation: (empty)')
  }

  parts.push('Classify the job and write the final Hermes cron prompt JSON.')

  return [
    { role: 'system', content: CRON_PROMPT_CLASSIFICATION_SYSTEM },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

export function sanitizeSynthesizedCronPrompt(raw: string): string | null {
  const trimmed = raw.trim().replace(/^```(?:json|markdown|text)?\s*|\s*```$/g, '').trim()
  if (!trimmed) {
    return null
  }

  const capped = trimmed.slice(0, MAX_SYNTHESIZED_CRON_PROMPT_CHARS).trim()
  return capped.length > 0 ? capped : null
}

export function parseClassifiedCronPromptResponse(raw: string): ClassifiedCronPrompt | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as { kind?: unknown; prompt?: unknown }
    const kind = normalizeCompanionCronJobKind(parsed.kind)
    if (!kind) {
      return null
    }

    const prompt =
      typeof parsed.prompt === 'string' ? sanitizeSynthesizedCronPrompt(parsed.prompt) : null

    return { kind, prompt }
  } catch {
    const fallbackPrompt = sanitizeSynthesizedCronPrompt(trimmed)
    if (!fallbackPrompt) {
      return null
    }

    return { kind: 'reminder', prompt: fallbackPrompt }
  }
}

function normalizeCompanionCronJobKind(value: unknown): CompanionCronJobKind | null {
  if (value === 'reminder' || value === 'ha_digest' || value === 'monitoring') {
    return value
  }

  return null
}

export async function classifyAndSynthesizeCompanionCronPrompt(input: {
  hermesClient: HermesClient
  synthesisLlm?: AuxiliaryLlmConfig | null
  messages: MessageRow[]
  job: Pick<HermesCronJob, 'name' | 'prompt' | 'schedule_display'>
}): Promise<ClassifiedCronPrompt | null> {
  if (input.messages.length === 0) {
    return null
  }

  const userTriggerMessage = findUserTriggerMessage(input.messages)
  const promptMessages = buildCronPromptSynthesisMessages({
    job: input.job,
    messages: input.messages,
    userTriggerMessage,
  })

  try {
    const raw = isAuxiliaryLlmConfigured(input.synthesisLlm)
      ? await completeAuxiliaryLlm(input.synthesisLlm!, promptMessages, {
          maxCompletionTokens: CRON_PROMPT_SYNTHESIS_MAX_COMPLETION_TOKENS,
        })
      : await input.hermesClient.completeChat({
          hermesSessionId: COMPANION_CRON_PROMPT_SYNTHESIS_SESSION_KEY,
          messages: promptMessages,
        })

    const classified = parseClassifiedCronPromptResponse(raw)
    if (classified) {
      return classified
    }
  } catch {
    // fall through to heuristic
  }

  const kind = inferCompanionCronJobKindHeuristic({
    name: input.job.name,
    prompt: input.job.prompt,
    schedule_display: input.job.schedule_display,
    userTriggerMessage,
  })

  if (kind === 'ha_digest') {
    return { kind, prompt: null }
  }

  const draftPrompt = sanitizeSynthesizedCronPrompt(input.job.prompt?.trim() ?? '')
  return draftPrompt ? { kind, prompt: draftPrompt } : null
}

export async function classifyAndSynthesizeCompanionCronPromptFromConversation(input: {
  db: Database.Database
  hermesClient: HermesClient
  synthesisLlm?: AuxiliaryLlmConfig | null
  sourceConversationId: string
  job: Pick<HermesCronJob, 'name' | 'prompt' | 'schedule_display'>
  messageLimit?: number
}): Promise<ClassifiedCronPrompt | null> {
  const messages = listRecentMessages(
    input.db,
    input.sourceConversationId,
    input.messageLimit ?? DEFAULT_CRON_PROMPT_MESSAGE_LIMIT,
  )

  return classifyAndSynthesizeCompanionCronPrompt({
    hermesClient: input.hermesClient,
    synthesisLlm: input.synthesisLlm,
    messages,
    job: input.job,
  })
}

/** @deprecated Use classifyAndSynthesizeCompanionCronPrompt instead. */
export async function synthesizeCompanionCronPrompt(input: {
  hermesClient: HermesClient
  synthesisLlm?: AuxiliaryLlmConfig | null
  messages: MessageRow[]
  job: Pick<HermesCronJob, 'name' | 'prompt' | 'schedule_display'>
}): Promise<string | null> {
  const classified = await classifyAndSynthesizeCompanionCronPrompt(input)
  return classified?.kind === 'reminder' || classified?.kind === 'monitoring'
    ? classified.prompt
    : null
}

/** @deprecated Use classifyAndSynthesizeCompanionCronPromptFromConversation instead. */
export async function synthesizeCompanionCronPromptFromConversation(input: {
  db: Database.Database
  hermesClient: HermesClient
  synthesisLlm?: AuxiliaryLlmConfig | null
  sourceConversationId: string
  job: Pick<HermesCronJob, 'name' | 'prompt' | 'schedule_display'>
  messageLimit?: number
}): Promise<string | null> {
  const classified = await classifyAndSynthesizeCompanionCronPromptFromConversation(input)
  return classified?.kind === 'reminder' || classified?.kind === 'monitoring'
    ? classified.prompt
    : null
}