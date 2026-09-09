import type Database from 'better-sqlite3'
import { getBotById, listBotsForRoster, normalizeBotRuntime } from '../db/repos/bots.js'
import { listAttachmentsForMessages } from '../db/repos/message-attachments.js'
import { botSummariesForMessages } from '../lib/attachment-serializer.js'
import {
  getConversationBotSlug,
  rotateHermesSessionId,
  updateConversationModel,
  type ConversationRow,
} from '../db/repos/conversations.js'
import { buildBotRosterPrompt } from '../lib/bot-roster.js'
import { DEFAULT_BOT_SLUG } from '../lib/hermes-profile.js'
import { listMessages } from '../db/repos/messages.js'
import { getActiveRun } from '../db/repos/runs.js'
import { assertCuratedModel, type CuratedModelEntry } from '../lib/companion-models.js'
import { resolveJobConversationBootstrap } from '../lib/job-conversation.js'
import type { HermesClient } from './hermes-client.js'
import { buildHermesMessages } from './prompt-builder.js'
import { scheduleConversationSessionWarmup } from './session-warmup.js'

export type ModelChangeErrorCode = 'invalid_request' | 'run_conflict' | 'invalid_model' | 'grok_runtime'

export class ModelChangeError extends Error {
  constructor(readonly code: ModelChangeErrorCode) {
    super(code)
  }
}

export interface ModelChangeResult {
  conversation: ConversationRow
  providerChanged: boolean
  previousHermesSessionId: string
  hermesSessionId: string
}

const CONTEXT_REBUILD_PROVIDER_CHANGE_USER_MESSAGE =
  '[System: LLM provider changed. Re-read the conversation history above. Reply with exactly "OK" and nothing else.]'

export async function rewarmSessionTranscript(input: {
  db: Database.Database
  hermesClient: HermesClient
  conversation: ConversationRow
  companionUsername?: string
  attachmentsDir?: string
  visionHistoryMaxBytes?: number
  rebuildUserMessage?: string
}): Promise<void> {
  const history = listMessages(input.db, input.conversation.id)
  if (history.length === 0) {
    return
  }

  const attachmentMap = listAttachmentsForMessages(
    input.db,
    history.map((message) => message.id),
  )
  const bots = botSummariesForMessages(input.db, history)
  const historyWithAttachments = history.map((message) => ({
    ...message,
    attachments: attachmentMap.get(message.id),
    from_bot: message.from_bot_id ? bots.get(message.from_bot_id) ?? null : null,
    to_bot: message.to_bot_id ? bots.get(message.to_bot_id) ?? null : null,
  }))

  const bootstrapPrompt = input.companionUsername
    ? resolveJobConversationBootstrap(input.conversation, input.companionUsername)
    : input.conversation.bootstrap_prompt

  const botSlug = getConversationBotSlug(input.db, input.conversation.id)
  const rosterPrompt =
    input.conversation.kind !== 'job' && botSlug
      ? buildBotRosterPrompt(listBotsForRoster(input.db), botSlug)
      : undefined

  const messages = await buildHermesMessages(historyWithAttachments, {
    bootstrapPrompt,
    companionUsername: input.companionUsername,
    rosterPrompt,
    attachmentsDir: input.attachmentsDir,
    userId: input.conversation.user_id,
    visionHistoryMaxBytes: input.visionHistoryMaxBytes,
    currentBotId: input.conversation.bot_id,
  })

  messages.push({
    role: 'user',
    content: input.rebuildUserMessage ?? CONTEXT_REBUILD_PROVIDER_CHANGE_USER_MESSAGE,
  })

  const profileSlug = botSlug && botSlug !== DEFAULT_BOT_SLUG ? botSlug : undefined

  await input.hermesClient.completeChat({
    hermesSessionId: input.conversation.hermes_session_id,
    messages,
    ...(profileSlug ? { profileSlug } : {}),
  })
}

export async function applyConversationModelChange(input: {
  db: Database.Database
  hermesClient: HermesClient
  catalog: CuratedModelEntry[]
  userId: string
  conversation: ConversationRow
  model: string
  provider: string
  companionUsername?: string
  attachmentsDir?: string
  visionHistoryMaxBytes?: number
}): Promise<ModelChangeResult> {
  try {
    assertCuratedModel(input.catalog, input.model, input.provider)
  } catch {
    throw new ModelChangeError('invalid_model')
  }

  if (input.conversation.kind === 'job') {
    throw new ModelChangeError('invalid_request')
  }

  const bot = input.conversation.bot_id ? getBotById(input.db, input.conversation.bot_id) : undefined
  if (bot && normalizeBotRuntime(bot.runtime) === 'grok') {
    throw new ModelChangeError('grok_runtime')
  }

  if (getActiveRun(input.db, input.conversation.id)) {
    throw new ModelChangeError('run_conflict')
  }

  const previousHermesSessionId = input.conversation.hermes_session_id
  const sameProvider = input.conversation.provider === input.provider

  if (sameProvider) {
    await input.hermesClient.patchSessionModel({
      hermesSessionId: previousHermesSessionId,
      model: input.model,
      provider: input.provider,
    })

    const updated = updateConversationModel(
      input.db,
      input.conversation.id,
      input.model,
      input.provider,
    )
    if (!updated) {
      throw new ModelChangeError('invalid_request')
    }

    return {
      conversation: updated,
      providerChanged: false,
      previousHermesSessionId,
      hermesSessionId: previousHermesSessionId,
    }
  }

  const hermesSessionId = rotateHermesSessionId(input.db, input.conversation.id)
  const updated = updateConversationModel(
    input.db,
    input.conversation.id,
    input.model,
    input.provider,
  )
  if (!updated) {
    throw new ModelChangeError('invalid_request')
  }

  scheduleConversationSessionWarmup({
    hermesClient: input.hermesClient,
    conversation: updated,
    db: input.db,
    companionUsername: input.companionUsername,
  })

  await rewarmSessionTranscript({
    db: input.db,
    hermesClient: input.hermesClient,
    conversation: updated,
    companionUsername: input.companionUsername,
    attachmentsDir: input.attachmentsDir,
    visionHistoryMaxBytes: input.visionHistoryMaxBytes,
  })

  return {
    conversation: updated,
    providerChanged: true,
    previousHermesSessionId,
    hermesSessionId,
  }
}