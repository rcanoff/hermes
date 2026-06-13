import type { AddressEnrichmentQueue } from './services/address-enrichment.js'
import type { HermesClient } from './services/hermes-client.js'
import type { StreamHub } from './streams/hub.js'

export interface AppOptions {
  dbPath: string
  jwtSecret: string
  hermesBaseUrl: string
  hermesApiKey: string
  bootstrapUsername: string
  bootstrapPassword: string
  companionMcpBearerToken: string
  addressEnrichmentSessionId: string
  hermesClient?: HermesClient
  streamHub?: StreamHub
  addressEnrichmentQueue?: AddressEnrichmentQueue
}
