import type Database from 'better-sqlite3'
import { getBotById, listBotsForRoster } from '../db/repos/bots.js'
import type { ConversationRow } from '../db/repos/conversations.js'
import { buildBotRosterPrompt } from '../lib/bot-roster.js'
import { DEFAULT_BOT_SLUG } from '../lib/hermes-profile.js'
import { resolveJobConversationBootstrap } from '../lib/job-conversation.js'
import type { HermesClient } from './hermes-client.js'
import { buildHermesSystemPrompt } from './prompt-builder.js'

export function scheduleConversationSessionWarmup(input: {
  hermesClient: HermesClient
  conversation: Pick<
    ConversationRow,
    | 'hermes_session_id'
    | 'bootstrap_prompt'
    | 'kind'
    | 'hermes_job_id'
    | 'title'
    | 'schedule_display'
    | 'model'
    | 'provider'
  > & { bot_id?: string | null }
  db?: Database.Database
  companionUsername?: string
  log?: (message: string, meta?: Record<string, unknown>) => void
}): void {
  const bootstrapPrompt = input.companionUsername
    ? resolveJobConversationBootstrap(input.conversation, input.companionUsername)
    : input.conversation.bootstrap_prompt

  const botSlug =
    input.db && input.conversation.bot_id
      ? getBotById(input.db, input.conversation.bot_id)?.slug
      : undefined
  const profileSlug = botSlug && botSlug !== DEFAULT_BOT_SLUG ? botSlug : undefined
  const rosterPrompt =
    input.db && input.conversation.kind !== 'job' && botSlug
      ? buildBotRosterPrompt(listBotsForRoster(input.db), botSlug)
      : undefined

  const systemPrompt = buildHermesSystemPrompt({
    bootstrapPrompt,
    companionUsername: input.companionUsername,
    rosterPrompt,
  })

  void input.hermesClient
    .ensureSession({
      hermesSessionId: input.conversation.hermes_session_id,
      systemPrompt: systemPrompt || null,
      model: input.conversation.model,
      provider: input.conversation.provider,
      ...(profileSlug ? { profileSlug } : {}),
    })
    .catch((error) => {
      input.log?.('conversation session warmup failed', {
        hermesSessionId: input.conversation.hermes_session_id,
        err: error instanceof Error ? error.message : String(error),
      })
    })
}