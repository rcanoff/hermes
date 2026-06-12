import Fastify from 'fastify'
import type Database from 'better-sqlite3'
import jwt from '@fastify/jwt'
import type { AppOptions } from './types.js'
import { getDb } from './db/index.js'
import { ensureBootstrapUser, findUserByUsername, updateUserPasswordHash } from './db/repos/users.js'
import authPlugin from './plugins/auth.js'
import authRoutes from './routes/auth.js'
import conversationRoutes from './routes/conversations.js'
import locationRoutes from './routes/locations.js'
import { hashPassword, verifyPassword } from './services/password.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database
  }
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true })

  app.register(jwt, { secret: options.jwtSecret })
  app.decorate('db', getDb(options.dbPath))
  app.register(authPlugin)
  app.register(authRoutes)
  app.register(conversationRoutes)
  app.register(locationRoutes)

  app.addHook('onReady', async () => {
    // MVP contract: the configured bootstrap credentials remain authoritative at startup
    // until real account-management flows exist, so restarts reconcile the stored hash.
    const existingUser = findUserByUsername(app.db, options.bootstrapUsername)
    if (!existingUser) {
      const passwordHash = await hashPassword(options.bootstrapPassword)
      ensureBootstrapUser(app.db, options.bootstrapUsername, passwordHash)
      return
    }

    const passwordMatches = await verifyPassword(options.bootstrapPassword, existingUser.password_hash)
    if (!passwordMatches) {
      const passwordHash = await hashPassword(options.bootstrapPassword)
      updateUserPasswordHash(app.db, existingUser.id, passwordHash)
    }
  })

  app.get('/health', async () => ({ ok: true }))

  return app
}
