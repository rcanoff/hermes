import type { FastifyPluginAsync } from 'fastify'
import { lookupInviteByRawToken } from '../services/invites.js'

const inviteLandingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/invite/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const lookup = lookupInviteByRawToken(app.db, token)
    if (!lookup.valid) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply.redirect(`hermes-companion://invite/${token}`)
  })
}

export default inviteLandingRoutes