import Fastify from 'fastify'
import type Database from 'better-sqlite3'
import jwt from '@fastify/jwt'
import type { AppOptions } from './types.js'
import { getDb } from './db/index.js'
import authPlugin from './plugins/auth.js'
import ssePlugin from './plugins/sse.js'
import authRoutes from './routes/auth.js'
import inviteLandingRoutes from './routes/invite-landing.js'
import chatSyncRoutes from './routes/chat-sync.js'
import conversationRoutes from './routes/conversations.js'
import messageRoutes from './routes/messages.js'
import eventsRoutes from './routes/events.js'
import dataLocationRoutes from './routes/data-location.js'
import dataHealthRoutes from './routes/data-health.js'
import mcpRoutes from './routes/mcp.js'
import jobRoutes from './routes/jobs.js'
import cronInternalRoutes from './routes/cron-internal.js'
import { AddressEnrichmentQueue } from './services/address-enrichment.js'
import { OpenAiHermesClient } from './services/hermes-client.js'
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
    cronWebhookBearer: string
    messagingApiHost: string
    inviteExpiryHours: number
    minPasswordLength: number
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
  app.decorate('cronWebhookBearer', options.cronWebhookBearer)
  app.decorate('messagingApiHost', options.messagingApiHost)
  app.decorate('inviteExpiryHours', options.inviteExpiryHours)
  app.decorate('minPasswordLength', options.minPasswordLength)
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
  app.register(inviteLandingRoutes)
  app.register(authRoutes)
  app.register(chatSyncRoutes)
  app.register(conversationRoutes)
  app.register(jobRoutes)
  app.register(cronInternalRoutes)
  app.register(messageRoutes)
  app.register(eventsRoutes)
  app.register(dataLocationRoutes)
  app.register(dataHealthRoutes)
  app.register(mcpRoutes)

  app.get('/health', async () => ({ ok: true }))

  return app
}