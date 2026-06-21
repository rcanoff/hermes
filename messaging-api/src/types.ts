import type { ApnsConfig, TitleGenerationConfig } from './config.js'
import type { AddressEnrichmentQueue } from './services/address-enrichment.js'
import type { ApnsClient } from './services/apns-client.js'
import type { CronOutputBridge } from './services/cron-output-bridge.js'
import type { HermesClient } from './services/hermes-client.js'
import type { PushNotificationService } from './services/push-notifications.js'
import type { StreamHub } from './streams/hub.js'

export interface AppOptions {
  dbPath: string
  jwtSecret: string
  hermesBaseUrl: string
  hermesApiKey: string
  messagingApiHost: string
  inviteExpiryHours: number
  minPasswordLength: number
  companionMcpBearerToken: string
  cronWebhookBearer: string
  cronOutputDir: string
  cronJobsPath: string
  cronOutputPollMs: number
  addressEnrichmentSessionId: string
  titleGeneration: TitleGenerationConfig
  apns: ApnsConfig
  syncInboxMaxGap: number
  attachmentsDir: string
  attachmentMaxBytes: number
  attachmentOrphanTtlHours: number
  visionMaxEdgePx: number
  thumbMaxEdgePx: number
  visionHistoryMaxBytes: number
  apnsClient?: ApnsClient
  cronOutputBridge?: CronOutputBridge
  hermesClient?: HermesClient
  streamHub?: StreamHub
  addressEnrichmentQueue?: AddressEnrichmentQueue
  pushNotifications?: PushNotificationService
  streamWaitMs?: number
}