import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { listConversationMemberIds } from '../db/repos/conversation-members.js'
import { finishGroupRun } from '../db/repos/group-bot-runs.js'
import { appendAccountConversationDeleted } from '../db/repos/chat-sync-events.js'
import {
  createConversation,
  createGroupConversation,
  createOrOpenUserDm,
  deleteConversationForUser,
  getConversationForUser,
  listConversationsPage,
  normalizeConversationTitle,
  updateConversationTitle,
  updateGroupSettings,
  type ConversationRow,
} from '../db/repos/conversations.js'
import { enqueueConversationAttachments } from '../services/attachment-cleanup.js'
import { resolveDefaultModel } from '../db/repos/settings.js'
import { getBotByIdForUser, getBotBySlug, normalizeBotRuntime } from '../db/repos/bots.js'
import { DEFAULT_BOT_SLUG } from '../lib/hermes-profile.js'
import { isBotColor, isBotIcon, DEFAULT_BOT_COLOR, DEFAULT_BOT_ICON } from '../lib/bot-appearance.js'
import {
  GROK_TUI_PROVIDER,
  assertCuratedModel,
  curatedGrokTuiModels,
} from '../lib/companion-models.js'
import { validateBootstrap } from '../lib/bootstrap.js'
import { getActiveRun } from '../db/repos/runs.js'
import { buildHalLinks, isValidAnchor, parseListAnchors, parsePageLimit } from '../lib/pagination.js'
import { toConversationResponse } from '../lib/conversation-response.js'
import {
  emitAccountConversationUpsert,
  emitConversationDeleted,
} from '../services/chat-sync-emitter.js'
import {
  publishAccountConversationUpsert,
  publishConversationDeleted,
  publishMessageUpsert,
} from '../streams/sse-mutation-publisher.js'
import { removeHermesCronJob } from '../lib/hermes-cron-jobs.js'
import {
  applyConversationModelChange,
  ModelChangeError,
} from '../services/conversation-model-change.js'
import { GrokGatewayError } from '../services/grok-gateway-client.js'
import { scheduleConversationSessionWarmup } from '../services/session-warmup.js'

const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as {
      limit?: string
      before?: string
      after?: string
      bot_id?: string
      include_shared?: string
    }
    const includeShared = query.include_shared === 'true'
    const limit = parsePageLimit(query.limit)
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const anchors = parseListAnchors(query)
    if (anchors === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    let botId: string | undefined
    if (query.bot_id !== undefined) {
      if (!isValidAnchor(query.bot_id)) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      if (!getBotByIdForUser(app.db, request.userId, query.bot_id)) {
        return reply.code(404).send({ error: 'not_found' })
      }
      botId = query.bot_id
    }

    const page = listConversationsPage(app.db, request.userId, limit, anchors, {
      kind: 'regular',
      botId,
      includeShared,
    })
    if (!page) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const firstId = page.conversations[0]?.id
    const lastId = page.conversations[page.conversations.length - 1]?.id

    return {
      conversations: page.conversations.map((row) =>
        toConversationResponse(app.db, row, app.companionModels),
      ),
      _links: buildHalLinks({
        basePath: '/conversations',
        limit,
        before: anchors.before,
        after: anchors.after,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        firstId,
        lastId,
        extraQuery: {
          ...(botId ? { bot_id: botId } : {}),
          ...(includeShared ? { include_shared: 'true' } : {}),
        },
      }),
    }
  })

  app.post('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
    const sharedKind = sharedCreateKind(request.body)
    if (sharedKind) {
      return createSharedConversation(app, request, reply, sharedKind)
    }

    let bootstrapPrompt: string | null = null
    let modelProvider: { model: string; provider: string } | undefined
    let botId: string | undefined
    let grokDefault: { model: string; provider: string } | undefined

    if (isCreateConversationBody(request.body)) {
      const bootstrap = validateBootstrap(request.body.bootstrap)
      if (request.body?.bootstrap !== undefined && !bootstrap) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      bootstrapPrompt = bootstrap

      const hasModel = request.body.model !== undefined
      const hasProvider = request.body.provider !== undefined
      if (hasModel !== hasProvider) {
        return reply.code(400).send({ error: 'invalid_request' })
      }

      if (request.body.bot_id !== undefined && request.body.bot_id !== null) {
        if (!isValidAnchor(request.body.bot_id)) {
          return reply.code(400).send({ error: 'invalid_request' })
        }
        if (!getBotByIdForUser(app.db, request.userId, request.body.bot_id)) {
          return reply.code(404).send({ error: 'not_found' })
        }
        botId = request.body.bot_id
      }

      const bot = botId ? getBotByIdForUser(app.db, request.userId, botId) : undefined
      const isGrok = Boolean(bot && normalizeBotRuntime(bot.runtime) === 'grok')
      let grokCatalog = app.companionModels
      if (isGrok) {
        try {
          const list = await app.grokGatewayClient.listModels()
          grokCatalog = curatedGrokTuiModels(list.models)
          grokDefault = { model: list.default, provider: GROK_TUI_PROVIDER }
        } catch (error) {
          if (error instanceof GrokGatewayError && error.code === 'grok_unavailable') {
            return reply.code(503).send({ error: 'grok_unavailable' })
          }
          throw error
        }
      }

      if (hasModel && hasProvider) {
        const model = request.body.model?.trim()
        const provider = request.body.provider?.trim()
        if (!model || !provider) {
          return reply.code(400).send({ error: 'invalid_request' })
        }

        try {
          assertCuratedModel(isGrok ? grokCatalog : app.companionModels, model, provider)
        } catch {
          return reply.code(400).send({ error: 'invalid_request' })
        }

        modelProvider = { model, provider }
      }
    }

    if (!botId) {
      const existingDefault = getBotBySlug(app.db, request.userId, DEFAULT_BOT_SLUG)
      if (!existingDefault) {
        return reply.code(400).send({ error: 'bot_required' })
      }
      botId = existingDefault.id
    }

    const conversationId = createConversation(
      app.db,
      request.userId,
      randomUUID(),
      bootstrapPrompt,
      modelProvider ?? grokDefault ?? resolveDefaultModel(app.db, app.hermesHome),
      botId,
    )
    emitAccountConversationUpsert(app.db, request.userId, conversationId, app.companionModels)
    publishAccountConversationUpsert(
      app.streamHub,
      app.db,
      request.userId,
      conversationId,
      app.companionModels,
    )
    const conversation = getConversationForUser(app.db, request.userId, conversationId)

    scheduleConversationSessionWarmup({
      hermesClient: app.hermesClient,
      conversation: conversation!,
      db: app.db,
      hermesHome: app.hermesHome,
      companionUserId: request.userId,
      companionUsername: request.username,
      log: (message, meta) => {
        app.log.info(meta ?? {}, message)
      },
    })

    return reply.code(201).send(toConversationResponse(app.db, conversation!, app.companionModels))
  })

  app.get('/conversations/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getConversationForUser(
      app.db,
      request.userId,
      (request.params as { id: string }).id,
    )

    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    return toConversationResponse(app.db, conversation, app.companionModels)
  })

  app.patch('/conversations/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    const existing = getConversationForUser(app.db, request.userId, conversationId)
    if (!existing) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (!isPatchConversationBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    if (existing.kind === 'user_dm' || existing.kind === 'group') {
      if (request.body.model !== undefined || request.body.provider !== undefined) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      if (existing.kind === 'user_dm') {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      if (existing.user_id !== request.userId) {
        return reply.code(403).send({ error: 'creator_required' })
      }
    }
    const groupPatch = existing.kind === 'group' ? groupSettingsPatch(request.body) : null
    if (groupPatch) {
      const oldMemberIds = listConversationMemberIds(app.db, conversationId)
      if ((request.body as { bot_id?: unknown }).bot_id !== undefined) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      if (groupPatch.botIds) {
        if (
          groupPatch.botIds.length > 6 ||
          groupPatch.botIds.some((id) => !isValidAnchor(id)) ||
          new Set(groupPatch.botIds).size !== groupPatch.botIds.length ||
          groupPatch.botIds.some((id) => !getBotByIdForUser(app.db, request.userId, id))
        ) {
          return reply.code(400).send({ error: 'invalid_request' })
        }
      }
      if (groupPatch.addUserIds) {
        if (
          groupPatch.addUserIds.includes(request.userId) ||
          new Set(groupPatch.addUserIds).size !== groupPatch.addUserIds.length ||
          !usersExist(app, groupPatch.addUserIds)
        ) {
          return reply.code(400).send({ error: 'invalid_request' })
        }
      }
      if (groupPatch.removeUserIds) {
        if (
          groupPatch.removeUserIds.includes(request.userId) ||
          new Set(groupPatch.removeUserIds).size !== groupPatch.removeUserIds.length ||
          !usersExist(app, groupPatch.removeUserIds) ||
          groupPatch.removeUserIds.some((id) => !oldMemberIds.includes(id))
        ) {
          return reply.code(400).send({ error: 'invalid_request' })
        }
      }

      const updated = (() => {
        try {
          return updateGroupSettings(app.db, conversationId, groupPatch)
        } catch (error) {
          if (
            error instanceof Error &&
            ['bot_cap', 'empty_roster'].includes(error.message)
          ) {
            return undefined
          }
          throw error
        }
      })()
      if (!updated) {
        return reply.code(400).send({ error: 'invalid_request' })
      }

      const remainingMemberIds = listConversationMemberIds(app.db, conversationId)
      for (const userId of remainingMemberIds) {
        emitAccountConversationUpsert(app.db, userId, conversationId, app.companionModels)
        publishAccountConversationUpsert(
          app.streamHub,
          app.db,
          userId,
          conversationId,
          app.companionModels,
        )
      }
      for (const userId of (groupPatch.removeUserIds ?? []).filter((id) => oldMemberIds.includes(id))) {
        if (remainingMemberIds.includes(userId)) {
          continue
        }
        appendAccountConversationDeleted(app.db, userId, conversationId)
        publishConversationDeleted(app.streamHub, userId, conversationId)
      }
      return toConversationResponse(app.db, updated, app.companionModels)
    }

    if (request.body.model !== undefined || request.body.provider !== undefined) {
      const model = request.body.model?.trim()
      const provider = request.body.provider?.trim()
      if (!model || !provider) {
        return reply.code(400).send({ error: 'invalid_request' })
      }

      try {
        const result = await applyConversationModelChange({
          db: app.db,
          hermesClient: app.hermesClient,
          grokGatewayClient: app.grokGatewayClient,
          catalog: app.companionModels,
          userId: request.userId,
          conversation: existing,
          model,
          provider,
          companionUsername: request.username,
          attachmentsDir: app.attachmentsDir,
          visionHistoryMaxBytes: app.visionHistoryMaxBytes,
          hermesHome: app.hermesHome,
        })

        emitAccountConversationUpsert(app.db, request.userId, conversationId, app.companionModels)
        publishAccountConversationUpsert(
          app.streamHub,
          app.db,
          request.userId,
          conversationId,
          app.companionModels,
        )
        if (result.notice) {
          publishMessageUpsert(
            app.streamHub,
            request.userId,
            conversationId,
            result.notice,
            result.hermesSessionId,
          )
        }

        return toConversationResponse(app.db, result.conversation, app.companionModels)
      } catch (error) {
        if (error instanceof ModelChangeError) {
          if (error.code === 'run_conflict') {
            return reply.code(409).send({ error: error.code })
          }
          if (error.code === 'grok_unavailable') {
            return reply.code(503).send({ error: 'grok_unavailable' })
          }
          return reply.code(400).send({ error: 'invalid_request' })
        }
        throw error
      }
    }

    const title = request.body.title
    if (title === undefined) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const normalizedTitle = normalizeConversationTitle(title)
    if (!normalizedTitle) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const updated = updateConversationTitle(app.db, conversationId, normalizedTitle)
    if (updated) {
      const userIds =
        updated.kind === 'group'
          ? listConversationMemberIds(app.db, conversationId)
          : [request.userId]
      for (const userId of userIds) {
        emitAccountConversationUpsert(app.db, userId, conversationId, app.companionModels)
        publishAccountConversationUpsert(
          app.streamHub,
          app.db,
          userId,
          conversationId,
          app.companionModels,
        )
      }
    }
    return updated ? toConversationResponse(app.db, updated, app.companionModels) : updated
  })

  app.delete('/conversations/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    const existing = getConversationForUser(app.db, request.userId, conversationId)
    if (!existing) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (existing.kind === 'user_dm') {
      return reply.code(409).send({ error: 'delete_unavailable' })
    }

    if (existing.kind === 'group') {
      if (existing.user_id !== request.userId) {
        return reply.code(403).send({ error: 'creator_required' })
      }
      const memberIds = deleteGroupConversation(app, conversationId, request.userId)
      for (const userId of memberIds) {
        publishConversationDeleted(app.streamHub, userId, conversationId)
      }
      return reply.code(204).send()
    }

    if (getActiveRun(app.db, conversationId)) {
      return reply.code(409).send({ error: 'run_conflict' })
    }

    if (existing.kind === 'job' && existing.hermes_job_id?.trim()) {
      const hermesJobId = existing.hermes_job_id.trim()
      try {
        const result = await removeHermesCronJob(app.cronJobsPath, hermesJobId)
        if (result === 'removed') {
          app.log.info({ hermesJobId, conversationId }, 'removed Hermes cron job for deleted job conversation')
        } else if (result === 'not_found') {
          app.log.warn(
            { hermesJobId, conversationId },
            'Hermes cron job not found while deleting job conversation',
          )
        } else {
          app.log.warn(
            { hermesJobId, conversationId },
            'Hermes cron jobs file missing while deleting job conversation',
          )
        }
      } catch (error) {
        app.log.error(
          {
            err: error instanceof Error ? error.message : String(error),
            hermesJobId,
            conversationId,
          },
          'failed to remove Hermes cron job for deleted job conversation',
        )
        return reply.code(500).send({ error: 'processing_failed' })
      }
    }

    if (existing.bot_id) {
      const bot = getBotByIdForUser(app.db, request.userId, existing.bot_id)
      if (bot && normalizeBotRuntime(bot.runtime) === 'grok') {
        try {
          await app.grokGatewayClient.deleteSession(conversationId)
        } catch (error) {
          app.log.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              conversationId,
            },
            'failed to delete grok gateway session',
          )
        }
      }
    }

    emitConversationDeleted(app.db, request.userId, conversationId)
    publishConversationDeleted(app.streamHub, request.userId, conversationId)
    deleteConversationForUser(app.db, request.userId, conversationId)
    return reply.code(204).send()
  })
}

export default conversationRoutes

function deleteGroupConversation(
  app: FastifyInstance,
  conversationId: string,
  userId: string,
): string[] {
  return app.db.transaction(() => {
    const memberIds = listConversationMemberIds(app.db, conversationId)
    enqueueConversationAttachments(app.db, conversationId)
    const runs = app.db
      .prepare(
        `
        SELECT message_id, bot_id, state
        FROM group_bot_runs
        WHERE conversation_id = ? AND state IN ('queued', 'running')
      `,
      )
      .all(conversationId) as Array<{ message_id: string; bot_id: string; state: 'queued' | 'running' }>
    for (const run of runs) {
      finishGroupRun(app.db, run.message_id, run.bot_id, run.state, 'cancelled')
    }
    for (const memberId of memberIds) {
      appendAccountConversationDeleted(app.db, memberId, conversationId)
    }
    app.db.prepare('DELETE FROM group_bot_runs WHERE conversation_id = ?').run(conversationId)
    if (!deleteConversationForUser(app.db, userId, conversationId)) {
      throw new Error('conversation_delete_failed')
    }
    app.db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(conversationId)
    return memberIds
  })()
}

function sharedCreateKind(body: unknown): 'user_dm' | 'group' | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const kind = (body as { kind?: unknown }).kind
  return kind === 'user_dm' || kind === 'group' ? kind : null
}

function participantIds(body: unknown): string[] | null {
  const raw = (body as { participant_user_ids?: unknown }).participant_user_ids
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    return null
  }
  const ids: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || !isValidAnchor(id)) {
      return null
    }
    ids.push(id)
  }
  return ids
}

function usersExist(app: FastifyInstance, ids: string[]): boolean {
  if (ids.length === 0) {
    return true
  }
  const placeholders = ids.map(() => '?').join(', ')
  const row = app.db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE id IN (${placeholders})`)
    .get(...ids) as { n: number }
  return row.n === ids.length
}

function publishSharedUpserts(app: FastifyInstance, conversationId: string): void {
  for (const userId of listConversationMemberIds(app.db, conversationId)) {
    publishAccountConversationUpsert(
      app.streamHub,
      app.db,
      userId,
      conversationId,
      app.companionModels,
    )
  }
}

async function createSharedConversation(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  kind: 'user_dm' | 'group',
) {
  const ids = participantIds(request.body)
  if (!ids) {
    return reply.code(400).send({ error: 'invalid_request' })
  }
  if (ids.includes(request.userId) || new Set(ids).size !== ids.length || !usersExist(app, ids)) {
    return reply.code(400).send({ error: 'invalid_request' })
  }

  const body = request.body as {
    bot_id?: unknown
    bot_ids?: unknown
    title?: unknown
    icon?: unknown
    color?: unknown
  }
  const hasBotId = Object.prototype.hasOwnProperty.call(body, 'bot_id')
  const hasBotIds = Object.prototype.hasOwnProperty.call(body, 'bot_ids')

  if (kind === 'user_dm') {
    if (ids.length !== 1 || hasBotId || hasBotIds) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    const opened = createOrOpenUserDm(app.db, request.userId, ids[0]!)
    if (opened.created) {
      publishSharedUpserts(app, opened.id)
    }
    const conversation = getConversationForUser(app.db, request.userId, opened.id)
    return reply.code(opened.created ? 201 : 200).send(
      toConversationResponse(app.db, conversation!, app.companionModels),
    )
  }

  if (hasBotId || !Array.isArray(body.bot_ids)) {
    return reply.code(400).send({ error: 'invalid_request' })
  }
  const botIds = body.bot_ids
  if (
    botIds.length > 6 ||
    botIds.some((id) => typeof id !== 'string' || !isValidAnchor(id)) ||
    new Set(botIds).size !== botIds.length ||
    botIds.some((id) => !getBotByIdForUser(app.db, request.userId, id))
  ) {
    return reply.code(400).send({ error: 'invalid_request' })
  }
  if (ids.length === 0 && botIds.length === 0) {
    return reply.code(400).send({ error: 'invalid_request' })
  }

  const title = typeof body.title === 'string' ? body.title.trim() : undefined
  if (title !== undefined && (title.length < 1 || title.length > 120)) {
    return reply.code(400).send({ error: 'invalid_request' })
  }
  if (body.icon !== undefined && !isBotIcon(body.icon)) {
    return reply.code(400).send({ error: 'invalid_request' })
  }
  if (body.color !== undefined && !isBotColor(body.color)) {
    return reply.code(400).send({ error: 'invalid_request' })
  }

  const conversationId = createGroupConversation(app.db, {
    callerId: request.userId,
    peerIds: ids,
    botIds,
    title,
    icon: isBotIcon(body.icon) ? body.icon : DEFAULT_BOT_ICON,
    color: isBotColor(body.color) ? body.color : DEFAULT_BOT_COLOR,
  })
  publishSharedUpserts(app, conversationId)
  const conversation = getConversationForUser(app.db, request.userId, conversationId)
  return reply.code(201).send(toConversationResponse(app.db, conversation!, app.companionModels))
}

function isCreateConversationBody(
  value: unknown,
): value is { bootstrap?: string; model?: string; provider?: string; bot_id?: string | null } {
  return typeof value === 'object' && value !== null
}

function isPatchConversationBody(
  value: unknown,
): value is {
  title?: string
  model?: string
  provider?: string
  icon?: string
  color?: string
  bot_id?: string
  bot_ids?: string[]
  add_user_ids?: string[]
  remove_user_ids?: string[]
} {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const body = value as {
    title?: unknown
    model?: unknown
    provider?: unknown
    icon?: unknown
    color?: unknown
    bot_id?: unknown
    bot_ids?: unknown
    add_user_ids?: unknown
    remove_user_ids?: unknown
  }
  const hasTitle = body.title !== undefined
  const hasModel = body.model !== undefined
  const hasProvider = body.provider !== undefined
  const hasIcon = body.icon !== undefined
  const hasColor = body.color !== undefined
  const hasBot = body.bot_id !== undefined
  const hasBots = body.bot_ids !== undefined
  const hasAdd = body.add_user_ids !== undefined
  const hasRemove = body.remove_user_ids !== undefined

  if (!hasTitle && !hasModel && !hasProvider && !hasIcon && !hasColor && !hasBot && !hasBots && !hasAdd && !hasRemove) {
    return false
  }

  if (hasTitle && typeof body.title !== 'string') return false
  if (hasModel && typeof body.model !== 'string') return false
  if (hasProvider && typeof body.provider !== 'string') return false
  if (hasIcon && !isBotIcon(body.icon)) return false
  if (hasColor && !isBotColor(body.color)) return false
  if (hasBot && typeof body.bot_id !== 'string') return false
  if (hasBots && (!Array.isArray(body.bot_ids) || body.bot_ids.some((id) => typeof id !== 'string'))) return false
  if (hasAdd && (!Array.isArray(body.add_user_ids) || body.add_user_ids.some((id) => typeof id !== 'string'))) {
    return false
  }
  if (
    hasRemove &&
    (!Array.isArray(body.remove_user_ids) || body.remove_user_ids.some((id) => typeof id !== 'string'))
  ) {
    return false
  }

  if ((hasModel || hasProvider) && !(hasModel && hasProvider)) {
    return false
  }

  return true
}

function groupSettingsPatch(body: {
  title?: string
  icon?: string
  color?: string
  bot_id?: string
  bot_ids?: string[]
  add_user_ids?: string[]
  remove_user_ids?: string[]
}): {
  title?: string
  icon?: string
  color?: string
  botIds?: string[]
  addUserIds?: string[]
  removeUserIds?: string[]
} | null {
  const title = typeof body.title === 'string' ? body.title.trim() : undefined
  if (title !== undefined && (title.length < 1 || title.length > 120)) return null
  const patch: {
    title?: string
    icon?: string
    color?: string
    botIds?: string[]
    addUserIds?: string[]
    removeUserIds?: string[]
  } = {}
  if (title !== undefined) patch.title = title
  if (body.icon !== undefined) patch.icon = body.icon
  if (body.color !== undefined) patch.color = body.color
  if (body.bot_ids !== undefined) patch.botIds = body.bot_ids
  if (body.add_user_ids !== undefined) patch.addUserIds = body.add_user_ids
  if (body.remove_user_ids !== undefined) patch.removeUserIds = body.remove_user_ids
  return Object.keys(patch).length > 0 ? patch : null
}
