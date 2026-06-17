import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { markInviteUsed } from '../db/repos/account-invites.js'
import { denyToken } from '../db/repos/sessions.js'
import { createUser, findUserById, findUserByUsername, updateUserPassword } from '../db/repos/users.js'
import {
  isUsernameValid,
  lookupInviteByRawToken,
  validatePassword,
} from '../services/invites.js'
import { hashPassword, verifyPassword } from '../services/password.js'

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
      { sub: user.id, username: user.username, jti: randomUUID() },
      { sign: { expiresIn: ONE_YEAR_IN_SECONDS } },
    )

    return { token }
  })

  app.get('/auth/invite/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const lookup = lookupInviteByRawToken(app.db, token)

    if (!lookup.valid) {
      return {
        valid: false,
        reason: lookup.reason,
      }
    }

    const invite = lookup.invite
    return {
      valid: true,
      type: invite.type,
      label: invite.label,
      expires_at: invite.expires_at,
    }
  })

  app.post('/auth/activate', async (request, reply) => {
    if (!isActivateBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const { token, username, password } = request.body
    const lookup = lookupInviteByRawToken(app.db, token)

    if (!lookup.valid || lookup.invite.type !== 'activation') {
      return reply.code(400).send({ error: 'invalid_token' })
    }

    if (!isUsernameValid(username)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    if (findUserByUsername(app.db, username)) {
      return reply.code(409).send({ error: 'username_taken' })
    }

    if (!validatePassword(password, app.minPasswordLength).ok) {
      return reply.code(400).send({ error: 'weak_password' })
    }

    const passwordHash = await hashPassword(password)
    const passwordChangedAt = new Date().toISOString()
    const user = createUser(app.db, { username, passwordHash, passwordChangedAt })
    markInviteUsed(app.db, lookup.invite.id)

    const jwtToken = await reply.jwtSign(
      { sub: user.id, username: user.username, jti: randomUUID() },
      { sign: { expiresIn: ONE_YEAR_IN_SECONDS } },
    )

    return { token: jwtToken }
  })

  app.post('/auth/reset-password', async (request, reply) => {
    if (!isResetPasswordBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const { token, password } = request.body
    const lookup = lookupInviteByRawToken(app.db, token)

    if (!lookup.valid || lookup.invite.type !== 'password_reset' || !lookup.invite.user_id) {
      return reply.code(400).send({ error: 'invalid_token' })
    }

    if (!validatePassword(password, app.minPasswordLength).ok) {
      return reply.code(400).send({ error: 'weak_password' })
    }

    const passwordHash = await hashPassword(password)
    const passwordChangedAtSec = Math.floor(Date.now() / 1000) + 1
    const passwordChangedAt = new Date(passwordChangedAtSec * 1000).toISOString()
    const userId = lookup.invite.user_id
    updateUserPassword(app.db, userId, passwordHash, passwordChangedAt)
    markInviteUsed(app.db, lookup.invite.id)

    const user = findUserById(app.db, userId)
    if (!user) {
      return reply.code(400).send({ error: 'invalid_token' })
    }

    const jwtToken = await app.jwt.sign(
      { sub: user.id, username: user.username, jti: randomUUID() },
      { expiresIn: ONE_YEAR_IN_SECONDS, iat: passwordChangedAtSec } as {
        expiresIn: number
        iat: number
      },
    )

    return { token: jwtToken }
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

function isActivateBody(value: unknown): value is { token: string; username: string; password: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { token?: unknown }).token === 'string' &&
    typeof (value as { username?: unknown }).username === 'string' &&
    typeof (value as { password?: unknown }).password === 'string'
  )
}

function isResetPasswordBody(value: unknown): value is { token: string; password: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { token?: unknown }).token === 'string' &&
    typeof (value as { password?: unknown }).password === 'string'
  )
}