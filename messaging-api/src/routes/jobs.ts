import type { FastifyPluginAsync } from 'fastify'
import { listConversationsPage } from '../db/repos/conversations.js'
import { toConversationResponse } from '../lib/conversation-response.js'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'

const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get('/jobs', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { limit?: string; before?: string; after?: string }
    const limit = parsePageLimit(query.limit)
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const anchors = parseListAnchors(query)
    if (anchors === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const page = listConversationsPage(app.db, request.userId, limit, anchors, { kind: 'job' })
    if (!page) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const firstId = page.conversations[0]?.id
    const lastId = page.conversations[page.conversations.length - 1]?.id

    return {
      jobs: page.conversations.map(toConversationResponse),
      _links: buildHalLinks({
        basePath: '/jobs',
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
}

export default jobRoutes