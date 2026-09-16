import Fastify from 'fastify'
import type Database from 'better-sqlite3'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import type { AppOptions } from './types.js'
import { getDb } from './db/index.js'
import authPlugin from './plugins/auth.js'
import ssePlugin from './plugins/sse.js'
import authRoutes from './routes/auth.js'
import inviteLandingRoutes from './routes/invite-landing.js'
import chatSyncRoutes from './routes/chat-sync.js'
import devicesRoutes from './routes/devices.js'
import syncInboxRoutes from './routes/sync-inbox.js'
import conversationRoutes from './routes/conversations.js'
import messageRoutes from './routes/messages.js'
import attachmentRoutes from './routes/attachments.js'
import { deleteExpiredOrphanAttachments } from './db/repos/message-attachments.js'
import { removeAttachmentTree } from './lib/attachment-storage.js'
import { drainAttachmentCleanup } from './services/attachment-cleanup.js'
import eventsRoutes from './routes/events.js'
import dataLocationRoutes from './routes/data-location.js'
import dataHealthRoutes from './routes/data-health.js'
import mcpRoutes from './routes/mcp.js'
import jobRoutes from './routes/jobs.js'
import botRoutes from './routes/bots.js'
import modelsRoutes from './routes/models.js'
import settingsRoutes from './routes/settings.js'
import cronInternalRoutes from './routes/cron-internal.js'
import pushRoutes from './routes/push.js'
import { AddressEnrichmentQueue } from './services/address-enrichment.js'
import { createApnsClient } from './services/apns-client.js'
import { CronOutputBridge } from './services/cron-output-bridge.js'
import { createGrokGatewayClient, type GrokGatewayClient } from './services/grok-gateway-client.js'
import { drainGrokOutboxesOnStartup } from './services/grok-outbox-drain.js'
import { OpenAiHermesClient } from './services/hermes-client.js'
import { PushNotificationService } from './services/push-notifications.js'
import { RunAbortRegistry } from './services/run-abort-registry.js'
import { StreamHub } from './streams/hub.js'
import type { ApnsConfig } from './config.js'
import type { ApnsClient } from './services/apns-client.js'
import type { HermesClient } from './services/hermes-client.js'
import type { AddressEnrichmentQueue as AddressEnrichmentQueueType } from './services/address-enrichment.js'
import type { PushNotificationService as PushNotificationServiceType } from './services/push-notifications.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database
    hermesClient: HermesClient
    grokGatewayClient: GrokGatewayClient
    streamHub: StreamHub
    addressEnrichmentQueue: AddressEnrichmentQueueType
    companionMcpBearerToken: string
    cronWebhookBearer: string
    cronJobsPath: string
    cronOutputBridge: CronOutputBridge
    apnsConfig: ApnsConfig
    apnsClient: ApnsClient
    pushNotifications: PushNotificationServiceType
    messagingApiHost: string
    inviteExpiryHours: number
    minPasswordLength: number
    streamWaitMs: number
    syncInboxMaxGap: number
    attachmentsDir: string
    attachmentMaxBytes: number
    attachmentOrphanTtlHours: number
    visionMaxEdgePx: number
    thumbMaxEdgePx: number
    visionHistoryMaxBytes: number
    titleGeneration: import('./config.js').TitleGenerationConfig
    cronPromptSynthesis: import('./services/auxiliary-llm-client.js').AuxiliaryLlmConfig
    companionModels: import('./lib/companion-models.js').CuratedModelEntry[]
    hermesHome: string
    runAbortRegistry: RunAbortRegistry
  }
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true })

  app.register(jwt, { secret: options.jwtSecret })
  app.register(multipart, { limits: { fileSize: options.attachmentMaxBytes } })
  app.decorate('db', getDb(options.dbPath))
  app.decorate(
    'hermesClient',
    options.hermesClient ??
      new OpenAiHermesClient(
        options.hermesBaseUrl,
        options.hermesApiKey,
        options.hermesStateDbPath,
      ),
  )
  app.decorate(
    'grokGatewayClient',
    options.grokGatewayClient ??
      createGrokGatewayClient(options.grokGatewayUrl, options.grokGatewayToken),
  )
  app.decorate('streamHub', options.streamHub ?? new StreamHub())
  app.decorate('runAbortRegistry', new RunAbortRegistry())
  app.decorate('streamWaitMs', options.streamWaitMs ?? 30_000)
  app.decorate('companionMcpBearerToken', options.companionMcpBearerToken)
  app.decorate('cronWebhookBearer', options.cronWebhookBearer)
  app.decorate('cronJobsPath', options.cronJobsPath)
  app.decorate('apnsConfig', options.apns)
  const apnsClient = options.apnsClient ?? createApnsClient(options.apns)
  app.decorate('apnsClient', apnsClient)
  const pushNotifications =
    options.pushNotifications ??
    new PushNotificationService(
      app.db,
      app.streamHub,
      apnsClient,
      options.apns,
      (message, meta) => {
        app.log.info(meta ?? {}, message)
      },
    )
  app.decorate('pushNotifications', pushNotifications)
  const cronOutputBridge =
    options.cronOutputBridge ??
    new CronOutputBridge({
      db: app.db,
      outputDir: options.cronOutputDir,
      hermesStateDbPath: options.hermesStateDbPath,
      pollMs: options.cronOutputPollMs * 1000,
      pushNotifications,
      log: (message, meta) => {
        app.log.info(meta ?? {}, message)
      },
    })
  app.decorate('cronOutputBridge', cronOutputBridge)
  app.decorate('messagingApiHost', options.messagingApiHost)
  app.decorate('inviteExpiryHours', options.inviteExpiryHours)
  app.decorate('minPasswordLength', options.minPasswordLength)
  app.decorate('syncInboxMaxGap', options.syncInboxMaxGap)
  app.decorate('attachmentsDir', options.attachmentsDir)
  app.decorate('attachmentMaxBytes', options.attachmentMaxBytes)
  app.decorate('attachmentOrphanTtlHours', options.attachmentOrphanTtlHours)
  app.decorate('visionMaxEdgePx', options.visionMaxEdgePx)
  app.decorate('thumbMaxEdgePx', options.thumbMaxEdgePx)
  app.decorate('visionHistoryMaxBytes', options.visionHistoryMaxBytes)
  app.decorate('titleGeneration', options.titleGeneration)
  app.decorate('cronPromptSynthesis', options.cronPromptSynthesis)
  app.decorate('companionModels', options.companionModels)
  app.decorate('hermesHome', options.hermesHome)
  app.decorate(
    'addressEnrichmentQueue',
    options.addressEnrichmentQueue ??
      new AddressEnrichmentQueue(
        app.db,
        app.hermesClient,
        options.addressEnrichmentSessionId,
      ),
  )
  const expiredOrphans = deleteExpiredOrphanAttachments(app.db)
  for (const orphan of expiredOrphans) {
    removeAttachmentTree(options.attachmentsDir, orphan.user_id, orphan.id)
  }

  const cleanupIntervalMs = options.attachmentCleanupIntervalMs
  if (cleanupIntervalMs > 0) {
    const cleanupLog = (message: string, meta?: Record<string, unknown>) => {
      app.log.warn(meta ?? {}, message)
    }
    void drainAttachmentCleanup(app.db, options.attachmentsDir, { log: cleanupLog }).catch(
      (error) => {
        app.log.error({ err: error }, 'attachment cleanup startup drain failed')
      },
    )
    const timer = setInterval(() => {
      void drainAttachmentCleanup(app.db, options.attachmentsDir, { log: cleanupLog }).catch(
        (error) => {
          app.log.error({ err: error }, 'attachment cleanup drain failed')
        },
      )
    }, cleanupIntervalMs)
    timer.unref?.()
    app.addHook('onClose', async () => {
      clearInterval(timer)
    })
  }

  app.register(authPlugin)
  app.register(ssePlugin)
  app.register(inviteLandingRoutes)
  app.register(authRoutes)
  app.register(chatSyncRoutes)
  app.register(devicesRoutes)
  app.register(syncInboxRoutes)
  app.register(conversationRoutes)
  app.register(modelsRoutes)
  app.register(settingsRoutes)
  app.register(jobRoutes)
  app.register(botRoutes)
  app.register(cronInternalRoutes)
  app.register(attachmentRoutes)
  app.register(messageRoutes)
  app.register(eventsRoutes)
  app.register(dataLocationRoutes)
  app.register(dataHealthRoutes)
  app.register(mcpRoutes)
  app.register(pushRoutes)

  app.get('/health', async () => ({ ok: true }))

  void drainGrokOutboxesOnStartup({
    db: app.db,
    client: app.grokGatewayClient,
    hub: app.streamHub,
    companionModels: options.companionModels,
    log: (message, meta) => {
      app.log.info(meta ?? {}, message)
    },
  }).catch((error) => {
    app.log.error({ err: error }, 'grok outbox startup drain failed')
  })

  return app
}