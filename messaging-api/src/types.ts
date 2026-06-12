import type { HermesClient } from './services/hermes-client.js'
import type { StreamHub } from './streams/hub.js'

export interface AppOptions {
  dbPath: string
  jwtSecret: string
  hermesBaseUrl: string
  bootstrapUsername: string
  bootstrapPassword: string
  hermesClient?: HermesClient
  streamHub?: StreamHub
}
