import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { denyToken } from '../db/repos/sessions.js'
import { findUserByUsername } from '../db/repos/users.js'
import { verifyPassword } from '../services/password.js'

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/login', async (request, reply) => {
    if (!isLoginBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const body = request.body
    const username = body.username?.trim()
    const password = body.password
    const user = username ? findUserByUsername(app.db, username) : undefined

    if (!user || !password || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' })
    }

    const token = await reply.jwtSign(
      { sub: user.id, username: user.username },
      { sign: { expiresIn: ONE_YEAR_IN_SECONDS } },
    )

    return { token }
  })

  app.post('/auth/logout', { preHandler: app.authenticate }, async (request, reply) => {
    const decoded = app.jwt.decode<{ exp?: number }>(request.bearerToken)
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000).toISOString()
      : new Date(Date.now() + ONE_YEAR_IN_SECONDS * 1000).toISOString()

    denyToken(app.db, {
      id: randomUUID(),
      userId: request.userId,
      token: request.bearerToken,
      expiresAt,
    })

    return reply.send({ ok: true })
  })

  app.get('/auth/me', { preHandler: app.authenticate }, async (request) => ({
    id: request.userId,
    username: request.username,
  }))
}

export default authRoutes

function isLoginBody(value: unknown): value is { username?: string; password?: string } {
  return typeof value === 'object' && value !== null
}
