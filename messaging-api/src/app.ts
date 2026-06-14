import Fastify from 'fastify'
import type Database from 'better-sqlite3'
import jwt from '@fastify/jwt'
import type { AppOptions } from './types.js'
import { getDb } from './db/index.js'
import { ensureBootstrapUser, findUserByUsername, updateUserPasswordHash } from './db/repos/users.js'
import authPlugin from './plugins/auth.js'
import ssePlugin from './plugins/sse.js'
import authRoutes from './routes/auth.js'
import conversationRoutes from './routes/conversations.js'
import messageRoutes from './routes/messages.js'
import dataLocationRoutes from './routes/data-location.js'
import mcpRoutes from './routes/mcp.js'
import { AddressEnrichmentQueue } from './services/address-enrichment.js'
import { OpenAiHermesClient } from './services/hermes-client.js'
import { hashPassword, verifyPassword } from './services/password.js'
import { StreamHub } from './streams/hub.js'
import type { HermesClient } from './services/hermes-client.js'
import type { AddressEnrichmentQueue as AddressEnrichmentQueueType } from './services/address-enrichment.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database
    hermesClient: HermesClient
    streamHub: StreamHub
    addressEnrichmentQueue: AddressEnrichmentQueueType
    companionMcpBearerToken: string
    bootstrapUsername: string
    streamWaitMs: number
  }
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true })

  app.register(jwt, { secret: options.jwtSecret })
  app.decorate('db', getDb(options.dbPath))
  app.decorate(
    'hermesClient',
    options.hermesClient ?? new OpenAiHermesClient(options.hermesBaseUrl, options.hermesApiKey),
  )
  app.decorate('streamHub', options.streamHub ?? new StreamHub())
  app.decorate('streamWaitMs', options.streamWaitMs ?? 30_000)
  app.decorate('companionMcpBearerToken', options.companionMcpBearerToken)
  app.decorate('bootstrapUsername', options.bootstrapUsername)
  app.decorate(
    'addressEnrichmentQueue',
    options.addressEnrichmentQueue ??
      new AddressEnrichmentQueue(
        app.db,
        app.hermesClient,
        options.addressEnrichmentSessionId,
      ),
  )
  app.register(authPlugin)
  app.register(ssePlugin)
  app.register(authRoutes)
  app.register(conversationRoutes)
  app.register(messageRoutes)
  app.register(dataLocationRoutes)
  app.register(mcpRoutes)

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
