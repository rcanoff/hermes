import type { AppOptions } from './types.js'

function requireEnv(env: NodeJS.ProcessEnv, key: 'JWT_SECRET' | 'BOOTSTRAP_PASSWORD') {
  const value = env[key]?.trim()

  if (!value) {
    throw new Error(`${key} is required`)
  }

  return value
}

export function readConfig(env: NodeJS.ProcessEnv): AppOptions {
  return {
    dbPath: env.DB_PATH ?? '/opt/data/messaging-api.sqlite',
    jwtSecret: requireEnv(env, 'JWT_SECRET'),
    hermesBaseUrl: env.HERMES_BASE_URL ?? 'http://localhost:8642',
    hermesApiKey: env.HERMES_API_KEY ?? '',
    bootstrapUsername: env.BOOTSTRAP_USERNAME ?? 'operator',
    bootstrapPassword: requireEnv(env, 'BOOTSTRAP_PASSWORD'),
    companionMcpBearerToken: env.COMPANION_MCP_BEARER_TOKEN ?? '',
    addressEnrichmentSessionId: env.ADDRESS_ENRICHMENT_SESSION_ID ?? 'companion-address-enrichment',
  }
}
