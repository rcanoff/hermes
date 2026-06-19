import { deriveCronJobsPath } from './lib/hermes-cron-jobs.js'
import type { AppOptions } from './types.js'

export interface ApnsConfig {
  enabled: boolean
  teamId: string
  keyId: string
  bundleId: string
  keyPath: string
  environment: 'development' | 'production'
  previewMaxChars: number
}

function readApnsConfig(env: NodeJS.ProcessEnv): ApnsConfig {
  const enabled = env.APNS_ENABLED === 'true'
  const apns: ApnsConfig = {
    enabled,
    teamId: env.APNS_TEAM_ID?.trim() ?? '',
    keyId: env.APNS_KEY_ID?.trim() ?? '',
    bundleId: env.APNS_BUNDLE_ID?.trim() ?? '',
    keyPath: env.APNS_KEY_PATH?.trim() ?? '',
    environment: env.APNS_ENVIRONMENT === 'production' ? 'production' : 'development',
    previewMaxChars: readPositiveInt(env.PUSH_PREVIEW_MAX_CHARS, 120),
  }

  if (enabled) {
    const required: Array<[keyof ApnsConfig, string]> = [
      ['teamId', 'APNS_TEAM_ID'],
      ['keyId', 'APNS_KEY_ID'],
      ['bundleId', 'APNS_BUNDLE_ID'],
      ['keyPath', 'APNS_KEY_PATH'],
    ]
    for (const [field, envKey] of required) {
      if (!apns[field]) {
        throw new Error(`${envKey} is required when APNS_ENABLED=true`)
      }
    }
  }

  return apns
}

function requireEnv(env: NodeJS.ProcessEnv, key: 'JWT_SECRET' | 'MESSAGING_API_HOST') {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`${key} is required`)
  }
  return value
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback
  }
  return parsed
}

export function readConfig(env: NodeJS.ProcessEnv): AppOptions {
  const apns = readApnsConfig(env)

  return {
    dbPath: env.DB_PATH ?? '/opt/data/messaging-api.sqlite',
    jwtSecret: requireEnv(env, 'JWT_SECRET'),
    hermesBaseUrl: env.HERMES_BASE_URL ?? 'http://localhost:8642',
    hermesApiKey: env.HERMES_API_KEY ?? '',
    messagingApiHost: requireEnv(env, 'MESSAGING_API_HOST'),
    inviteExpiryHours: readPositiveInt(env.INVITE_EXPIRY_HOURS, 48),
    minPasswordLength: readPositiveInt(env.MIN_PASSWORD_LENGTH, 12),
    companionMcpBearerToken: env.COMPANION_MCP_BEARER_TOKEN ?? '',
    cronWebhookBearer: env.CRON_WEBHOOK_BEARER ?? '',
    cronOutputDir: env.CRON_OUTPUT_DIR ?? '/opt/data/cron/output',
    cronJobsPath: env.CRON_JOBS_PATH?.trim() || deriveCronJobsPath(env.CRON_OUTPUT_DIR ?? '/opt/data/cron/output'),
    cronOutputPollMs: readPositiveInt(env.CRON_OUTPUT_POLL_MS, 5),
    addressEnrichmentSessionId: env.ADDRESS_ENRICHMENT_SESSION_ID ?? 'companion-address-enrichment',
    apns,
    syncInboxMaxGap: readPositiveInt(env.SYNC_INBOX_MAX_GAP, 500),
  }
}