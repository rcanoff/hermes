import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import {
  createConversation,
  deleteConversationForUser,
  getConversationForUser,
  listConversations,
  normalizeConversationTitle,
  updateConversationTitle,
} from '../db/repos/conversations.js'
import { getActiveRun } from '../db/repos/runs.js'

const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations', { preHandler: app.authenticate }, async (request) => {
    return listConversations(app.db, request.userId)
  })

  app.post('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = createConversation(app.db, request.userId, randomUUID())
    const conversation = getConversationForUser(app.db, request.userId, conversationId)

    return reply.code(201).send(conversation)
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

    return conversation
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
    return updated
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

function isPatchConversationBody(value: unknown): value is { title: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { title?: unknown }).title === 'string'
  )
}
