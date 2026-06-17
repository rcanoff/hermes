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
import { validateBootstrap } from '../lib/bootstrap.js'
import { getActiveRun } from '../db/repos/runs.js'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'

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
      conversations: page.conversations.map(toConversationResponse),
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
    if (isCreateConversationBody(request.body)) {
      const bootstrap = validateBootstrap(request.body.bootstrap)
      if (request.body?.bootstrap !== undefined && !bootstrap) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      bootstrapPrompt = bootstrap
    }

    const conversationId = createConversation(app.db, request.userId, randomUUID(), bootstrapPrompt)
    const conversation = getConversationForUser(app.db, request.userId, conversationId)

    return reply.code(201).send(toConversationResponse(conversation!))
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

    return toConversationResponse(conversation)
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

    const title = normalizeConversationTitle(request.body.title)
    if (!title) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const updated = updateConversationTitle(app.db, conversationId, title)
    return updated ? toConversationResponse(updated) : updated
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

    deleteConversationForUser(app.db, request.userId, conversationId)
    return reply.code(204).send()
  })
}

export default conversationRoutes

function toConversationResponse(conversation: ConversationRow) {
  const { bootstrap_prompt: _bootstrapPrompt, ...response } = conversation
  return response
}

function isCreateConversationBody(value: unknown): value is { bootstrap?: string } {
  return typeof value === 'object' && value !== null
}

function isPatchConversationBody(value: unknown): value is { title: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { title?: unknown }).title === 'string'
  )
}
