import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import {
  createConversation,
  deleteConversationForUser,
  getConversationForUser,
  listConversationsPage,
  normalizeConversationTitle,
  updateConversationTitle,
  type ConversationRow,
} from '../db/repos/conversations.js'
import { assertCuratedModel } from '../lib/companion-models.js'
import { validateBootstrap } from '../lib/bootstrap.js'
import { getActiveRun } from '../db/repos/runs.js'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'
import { toConversationResponse } from '../lib/conversation-response.js'
import {
  emitAccountConversationUpsert,
  emitConversationDeleted,
} from '../services/chat-sync-emitter.js'
import {
  publishAccountConversationUpsert,
  publishConversationDeleted,
} from '../streams/sse-mutation-publisher.js'
import { removeHermesCronJob } from '../lib/hermes-cron-jobs.js'
import {
  applyConversationModelChange,
  ModelChangeError,
} from '../services/conversation-model-change.js'
import { scheduleConversationSessionWarmup } from '../services/session-warmup.js'

const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { limit?: string; before?: string; after?: string }
    const limit = parsePageLimit(query.limit)
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const anchors = parseListAnchors(query)
    if (anchors === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const page = listConversationsPage(app.db, request.userId, limit, anchors)
    if (!page) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const firstId = page.conversations[0]?.id
    const lastId = page.conversations[page.conversations.length - 1]?.id

    return {
      conversations: page.conversations.map((row) =>
        toConversationResponse(row, app.companionModels),
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
      }),
    }
  })

  app.post('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
    let bootstrapPrompt: string | null = null
    let modelProvider: { model: string; provider: string } | undefined

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

      if (hasModel && hasProvider) {
        const model = request.body.model?.trim()
        const provider = request.body.provider?.trim()
        if (!model || !provider) {
          return reply.code(400).send({ error: 'invalid_request' })
        }

        try {
          assertCuratedModel(app.companionModels, model, provider)
        } catch {
          return reply.code(400).send({ error: 'invalid_request' })
        }

        modelProvider = { model, provider }
      }
    }

    const conversationId = createConversation(
      app.db,
      request.userId,
      randomUUID(),
      bootstrapPrompt,
      modelProvider,
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
      companionUsername: request.username,
      log: (message, meta) => {
        app.log.info(meta ?? {}, message)
      },
    })

    return reply.code(201).send(toConversationResponse(conversation!, app.companionModels))
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

    return toConversationResponse(conversation, app.companionModels)
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
          catalog: app.companionModels,
          userId: request.userId,
          conversation: existing,
          model,
          provider,
          companionUsername: request.username,
          attachmentsDir: app.attachmentsDir,
          visionHistoryMaxBytes: app.visionHistoryMaxBytes,
        })

        emitAccountConversationUpsert(app.db, request.userId, conversationId, app.companionModels)
        publishAccountConversationUpsert(
          app.streamHub,
          app.db,
          request.userId,
          conversationId,
          app.companionModels,
        )

        return toConversationResponse(result.conversation, app.companionModels)
      } catch (error) {
        if (error instanceof ModelChangeError) {
          if (error.code === 'run_conflict') {
            return reply.code(409).send({ error: 'run_conflict' })
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
      emitAccountConversationUpsert(app.db, request.userId, conversationId, app.companionModels)
      publishAccountConversationUpsert(
        app.streamHub,
        app.db,
        request.userId,
        conversationId,
        app.companionModels,
      )
    }
    return updated ? toConversationResponse(updated, app.companionModels) : updated
  })

  app.delete('/conversations/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    const existing = getConversationForUser(app.db, request.userId, conversationId)
    if (!existing) {
      return reply.code(404).send({ error: 'not_found' })
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

    emitConversationDeleted(app.db, request.userId, conversationId)
    publishConversationDeleted(app.streamHub, request.userId, conversationId)
    deleteConversationForUser(app.db, request.userId, conversationId)
    return reply.code(204).send()
  })
}

export default conversationRoutes

function isCreateConversationBody(
  value: unknown,
): value is { bootstrap?: string; model?: string; provider?: string } {
  return typeof value === 'object' && value !== null
}

function isPatchConversationBody(
  value: unknown,
): value is { title?: string; model?: string; provider?: string } {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const body = value as { title?: unknown; model?: unknown; provider?: unknown }
  const hasTitle = body.title !== undefined
  const hasModel = body.model !== undefined
  const hasProvider = body.provider !== undefined

  if (!hasTitle && !hasModel && !hasProvider) {
    return false
  }

  if (hasTitle && typeof body.title !== 'string') {
    return false
  }

  if (hasModel && typeof body.model !== 'string') {
    return false
  }

  if (hasProvider && typeof body.provider !== 'string') {
    return false
  }

  if ((hasModel || hasProvider) && !(hasModel && hasProvider)) {
    return false
  }

  return true
}
