import type { AppOptions } from './types.js'

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
    addressEnrichmentSessionId: env.ADDRESS_ENRICHMENT_SESSION_ID ?? 'companion-address-enrichment',
  }
}