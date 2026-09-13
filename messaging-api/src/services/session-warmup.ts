import type Database from 'better-sqlite3'
import { getBotById, hermesProfileKeyForBot, listBotsForRoster } from '../db/repos/bots.js'
import type { ConversationRow } from '../db/repos/conversations.js'
import { buildBotRosterPrompt } from '../lib/bot-roster.js'
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
  > & { bot_id?: string | null; user_id?: string }
  db?: Database.Database
  hermesHome?: string
  companionUserId?: string
  companionUsername?: string
  log?: (message: string, meta?: Record<string, unknown>) => void
}): void {
  const bootstrapPrompt = input.companionUsername
    ? resolveJobConversationBootstrap(input.conversation, input.companionUsername)
    : input.conversation.bootstrap_prompt

  const bot =
    input.db && input.conversation.bot_id
      ? getBotById(input.db, input.conversation.bot_id)
      : undefined
  const botSlug = bot?.slug
  const profileSlug = bot ? hermesProfileKeyForBot(bot, input.hermesHome) : undefined
  const rosterUserId = input.conversation.user_id ?? bot?.user_id
  const rosterPrompt =
    input.db && input.conversation.kind !== 'job' && botSlug && rosterUserId
      ? buildBotRosterPrompt(listBotsForRoster(input.db, rosterUserId), botSlug)
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
      ...(input.companionUserId ? { companionUserId: input.companionUserId } : {}),
      ...(input.companionUsername ? { companionUsername: input.companionUsername } : {}),
    })
    .catch((error) => {
      input.log?.('conversation session warmup failed', {
        hermesSessionId: input.conversation.hermes_session_id,
        err: error instanceof Error ? error.message : String(error),
      })
    })
}