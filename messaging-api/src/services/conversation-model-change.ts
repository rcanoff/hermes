import type Database from 'better-sqlite3'
import {
  getBotById,
  hermesProfileKeyForBot,
  listBotsForRoster,
  normalizeBotRuntime,
} from '../db/repos/bots.js'
import { listAttachmentsForMessages } from '../db/repos/message-attachments.js'
import { botSummariesForMessages, enrichMessageWithAttachments, type MessageWithAttachments } from '../lib/attachment-serializer.js'
import {
  appendAccountMessageUpsert,
  appendConversationMessageUpsert,
} from '../db/repos/chat-sync-events.js'
import { emitToConversationMembers } from './chat-sync-emitter.js'
import {
  getConversationBotSlug,
  rotateHermesSessionId,
  updateConversationModel,
  type ConversationRow,
} from '../db/repos/conversations.js'
import { buildBotRosterPrompt } from '../lib/bot-roster.js'
import { getMessage, insertMessage, listMessages } from '../db/repos/messages.js'
import { getActiveRun } from '../db/repos/runs.js'
import {
  assertCuratedModel,
  curatedGrokTuiModels,
  type CuratedModelEntry,
} from '../lib/companion-models.js'
import { resolveJobConversationBootstrap } from '../lib/job-conversation.js'
import { GrokGatewayError, type GrokGatewayClient } from './grok-gateway-client.js'
import type { HermesClient } from './hermes-client.js'
import { buildHermesMessages } from './prompt-builder.js'
import { scheduleConversationSessionWarmup } from './session-warmup.js'

export type ModelChangeErrorCode =
  | 'invalid_request'
  | 'run_conflict'
  | 'invalid_model'
  | 'grok_unavailable'

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
  notice?: MessageWithAttachments
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
  hermesHome?: string
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
      ? buildBotRosterPrompt(listBotsForRoster(input.db, input.conversation.user_id), botSlug)
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

  const bot = input.conversation.bot_id
    ? getBotById(input.db, input.conversation.bot_id)
    : undefined
  const profileSlug = bot ? hermesProfileKeyForBot(bot, input.hermesHome) : undefined

  await input.hermesClient.completeChat({
    hermesSessionId: input.conversation.hermes_session_id,
    messages,
    companionUserId: input.conversation.user_id,
    ...(input.companionUsername ? { companionUsername: input.companionUsername } : {}),
    ...(profileSlug ? { profileSlug } : {}),
    ...(input.conversation.model && input.conversation.provider
      ? { model: input.conversation.model, provider: input.conversation.provider }
      : {}),
  })
}

export async function applyConversationModelChange(input: {
  db: Database.Database
  hermesClient: HermesClient
  grokGatewayClient?: GrokGatewayClient
  catalog: CuratedModelEntry[]
  userId: string
  conversation: ConversationRow
  model: string
  provider: string
  companionUsername?: string
  attachmentsDir?: string
  visionHistoryMaxBytes?: number
  hermesHome?: string
}): Promise<ModelChangeResult> {
  const bot = input.conversation.bot_id ? getBotById(input.db, input.conversation.bot_id) : undefined
  if (bot && normalizeBotRuntime(bot.runtime) === 'grok') {
    if (input.conversation.kind === 'job') {
      throw new ModelChangeError('invalid_request')
    }
    return applyGrokConversationModelChange(input)
  }

  try {
    assertCuratedModel(input.catalog, input.model, input.provider)
  } catch {
    throw new ModelChangeError('invalid_model')
  }

  if (input.conversation.kind === 'job') {
    throw new ModelChangeError('invalid_request')
  }

  if (getActiveRun(input.db, input.conversation.id)) {
    throw new ModelChangeError('run_conflict')
  }

  const previousHermesSessionId = input.conversation.hermes_session_id
  const sameProvider = input.conversation.provider === input.provider

  if (sameProvider) {
    try {
      await input.hermesClient.patchSessionModel({
        hermesSessionId: previousHermesSessionId,
        model: input.model,
        provider: input.provider,
      })
    } catch {
      // The gateway owns state.db. A malformed or locked side write must not
      // roll back the picker; the next turn sends model and provider itself.
    }


    const updated = updateConversationModel(
      input.db,
      input.conversation.id,
      input.model,
      input.provider,
    )
    if (!updated) {
      throw new ModelChangeError('invalid_request')
    }

    return finishModelChange(input, updated, false, previousHermesSessionId, previousHermesSessionId)
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
    hermesHome: input.hermesHome,
    companionUserId: input.userId,
    companionUsername: input.companionUsername,
  })

  await rewarmSessionTranscript({
    db: input.db,
    hermesClient: input.hermesClient,
    conversation: updated,
    companionUsername: input.companionUsername,
    attachmentsDir: input.attachmentsDir,
    visionHistoryMaxBytes: input.visionHistoryMaxBytes,
    hermesHome: input.hermesHome,
  })

  return finishModelChange(input, updated, true, previousHermesSessionId, hermesSessionId)
}

async function applyGrokConversationModelChange(input: {
  db: Database.Database
  grokGatewayClient?: GrokGatewayClient
  conversation: ConversationRow
  model: string
  provider: string
}): Promise<ModelChangeResult> {
  if (getActiveRun(input.db, input.conversation.id)) {
    throw new ModelChangeError('run_conflict')
  }

  if (!input.grokGatewayClient) {
    throw new ModelChangeError('grok_unavailable')
  }

  let catalog: CuratedModelEntry[]
  try {
    const list = await input.grokGatewayClient.listModels()
    catalog = curatedGrokTuiModels(list.models)
  } catch (error) {
    if (error instanceof GrokGatewayError && error.code === 'grok_unavailable') {
      throw new ModelChangeError('grok_unavailable')
    }
    throw error
  }

  try {
    assertCuratedModel(catalog, input.model, input.provider)
  } catch {
    throw new ModelChangeError('invalid_request')
  }

  try {
    await input.grokGatewayClient.patchSessionModel(input.conversation.id, input.model)
  } catch (error) {
    if (error instanceof GrokGatewayError && error.code === 'grok_unavailable') {
      throw new ModelChangeError('grok_unavailable')
    }
    throw error
  }

  const previousHermesSessionId = input.conversation.hermes_session_id
  const updated = updateConversationModel(
    input.db,
    input.conversation.id,
    input.model,
    input.provider,
  )
  if (!updated) {
    throw new ModelChangeError('invalid_request')
  }

  return finishModelChange(
    input,
    updated,
    input.conversation.provider !== input.provider,
    previousHermesSessionId,
    previousHermesSessionId,
  )
}

async function finishModelChange(
  input: {
    db: Database.Database
    hermesClient?: HermesClient
    userId?: string
    conversation: ConversationRow
    model: string
    provider: string
    companionUsername?: string
    hermesHome?: string
  },
  updated: ConversationRow,
  providerChanged: boolean,
  previousHermesSessionId: string,
  hermesSessionId: string,
): Promise<ModelChangeResult> {
  const changed = input.conversation.model !== input.model || input.conversation.provider !== input.provider
  const bot = updated.bot_id ? getBotById(input.db, updated.bot_id) : undefined
  const hermes = !bot || normalizeBotRuntime(bot.runtime) !== 'grok'
  if (changed && hermes && !providerChanged && input.hermesClient) {
    const profileSlug = bot ? hermesProfileKeyForBot(bot, input.hermesHome) : undefined
    try {
      await input.hermesClient.ensureSession({
        hermesSessionId,
        model: input.model,
        provider: input.provider,
        ...(profileSlug ? { profileSlug } : {}),
        ...(input.userId ? { companionUserId: input.userId } : {}),
        ...(input.companionUsername ? { companionUsername: input.companionUsername } : {}),
      })
    } catch {
      // The next turn still sends model and provider on the chat request.
    }
  }

  const unchanged =
    input.conversation.model === input.model && input.conversation.provider === input.provider
  const notice = unchanged ? undefined : recordModelChangeNotice(input.db, updated, input.model, input.provider)
  return {
    conversation: updated,
    providerChanged,
    previousHermesSessionId,
    hermesSessionId,
    ...(notice ? { notice } : {}),
  }
}

function recordModelChangeNotice(
  db: Database.Database,
  conversation: ConversationRow,
  model: string,
  provider: string,
): MessageWithAttachments | undefined {
  const messageId = insertMessage(db, {
    conversationId: conversation.id,
    role: 'assistant',
    content: `model changed to ${provider} ${model}`,
    kind: 'notice',
  })
  const stored = getMessage(db, conversation.id, messageId)
  if (!stored) return undefined
  const enriched = enrichMessageWithAttachments(db, stored)
  emitToConversationMembers(db, conversation.id, (userId) => {
    appendAccountMessageUpsert(db, userId, conversation.id, enriched)
  })
  appendConversationMessageUpsert(db, conversation.user_id, conversation.id, enriched)
  return enriched
}