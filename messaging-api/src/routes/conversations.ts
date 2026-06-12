import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import {
  createConversation,
  getConversationForUser,
  listConversations,
} from '../db/repos/conversations.js'

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
}

export default conversationRoutes
