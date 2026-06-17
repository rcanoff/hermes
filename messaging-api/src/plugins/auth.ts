import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { isTokenDenied } from '../db/repos/sessions.js'
import { findUserById } from '../db/repos/users.js'

interface JwtClaims {
  sub: string
  username: string
  jti?: string
  iat?: number
  exp?: number
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtClaims
    user: JwtClaims
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
    username: string
    bearerToken: string
    sessionId: string | null
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearerToken(request.headers.authorization)
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized' })
    }

    try {
      const claims = app.jwt.verify<JwtClaims>(token)

      if (isTokenDenied(app.db, token)) {
        return reply.code(401).send({ error: 'unauthorized' })
      }

      const user = findUserById(app.db, claims.sub)
      if (!user) {
        return reply.code(401).send({ error: 'unauthorized' })
      }

      if (user.password_changed_at) {
        const issuedAt = claims.iat
        const changedAt = Math.floor(new Date(user.password_changed_at).getTime() / 1000)
        if (issuedAt !== undefined && issuedAt < changedAt) {
          return reply.code(401).send({ error: 'unauthorized' })
        }
      }

      request.userId = user.id
      request.username = user.username
      request.bearerToken = token
      request.sessionId = claims.jti ?? null
    } catch {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })
}

export default fp(authPlugin, { name: 'auth-plugin' })

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}
