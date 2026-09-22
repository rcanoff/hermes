import type { FastifyPluginAsync } from 'fastify'
import { listUsersExcept } from '../db/repos/users.js'

const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/users', { preHandler: app.authenticate }, async (request) => {
    return { users: listUsersExcept(app.db, request.userId) }
  })
}

export default userRoutes
