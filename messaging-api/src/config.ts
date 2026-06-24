import { deriveCronJobsPath } from './lib/hermes-cron-jobs.js'
import { parseCompanionModelsJson } from './lib/companion-models.js'
import type { AuxiliaryLlmConfig } from './services/auxiliary-llm-client.js'
import { DEFAULT_CRON_PROMPT_SYNTHESIS_MODEL } from './services/cron-prompt-synthesizer.js'
import type { AppOptions } from './types.js'

export const DEFAULT_TITLE_GENERATION_GROK_MODEL = 'grok-4.3'
export const DEFAULT_TITLE_GENERATION_OPENAI_MODEL = 'gpt-5.4-mini'

export interface HermesTitleProvider {
  provider: string
  model: string
}

export interface TitleGenerationConfig {
  bridgeUrl: string
  bridgeApiKey: string
  providers: HermesTitleProvider[]
  timeoutMs: number
}

export const DEFAULT_TITLE_GENERATION_PROVIDERS: HermesTitleProvider[] = [
  { provider: 'xai-oauth', model: DEFAULT_TITLE_GENERATION_GROK_MODEL },
  { provider: 'openai-codex', model: DEFAULT_TITLE_GENERATION_OPENAI_MODEL },
]

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

function readTitleGenerationConfig(env: NodeJS.ProcessEnv): TitleGenerationConfig {
  const timeoutMs = readPositiveInt(env.TITLE_GENERATION_TIMEOUT_MS, 30_000)
  const bridgeUrl = env.HERMES_AUXILIARY_BRIDGE_URL?.trim() || ''
  const bridgeApiKey = env.HERMES_API_KEY?.trim() || ''

  return {
    bridgeUrl,
    bridgeApiKey,
    providers: DEFAULT_TITLE_GENERATION_PROVIDERS,
    timeoutMs,
  }
}

function readCronPromptSynthesisConfig(env: NodeJS.ProcessEnv): AuxiliaryLlmConfig {
  return {
    apiKey:
      env.CRON_PROMPT_SYNTHESIS_API_KEY?.trim() ||
      env.TITLE_GENERATION_API_KEY?.trim() ||
      env.OPENAI_API_KEY?.trim() ||
      '',
    baseUrl:
      env.CRON_PROMPT_SYNTHESIS_BASE_URL?.trim() ||
      env.TITLE_GENERATION_BASE_URL?.trim() ||
      env.OPENAI_BASE_URL?.trim() ||
      '',
    model: env.CRON_PROMPT_SYNTHESIS_MODEL?.trim() || DEFAULT_CRON_PROMPT_SYNTHESIS_MODEL,
    timeoutMs: readPositiveInt(env.CRON_PROMPT_SYNTHESIS_TIMEOUT_MS, 60_000),
  }
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
    hermesStateDbPath: env.HERMES_STATE_DB_PATH?.trim() || '/opt/data/state.db',
    cronOutputPollMs: readPositiveInt(env.CRON_OUTPUT_POLL_MS, 5),
    addressEnrichmentSessionId: env.ADDRESS_ENRICHMENT_SESSION_ID ?? 'companion-address-enrichment',
    titleGeneration: readTitleGenerationConfig(env),
    cronPromptSynthesis: readCronPromptSynthesisConfig(env),
    apns,
    syncInboxMaxGap: readPositiveInt(env.SYNC_INBOX_MAX_GAP, 500),
    attachmentsDir: env.ATTACHMENTS_DIR?.trim() || '/opt/data/attachments',
    attachmentMaxBytes: readPositiveInt(env.ATTACHMENT_MAX_BYTES, 20_971_520),
    attachmentOrphanTtlHours: readPositiveInt(env.ATTACHMENT_ORPHAN_TTL_HOURS, 24),
    visionMaxEdgePx: readPositiveInt(env.VISION_MAX_EDGE_PX, 1536),
    thumbMaxEdgePx: readPositiveInt(env.THUMB_MAX_EDGE_PX, 200),
    visionHistoryMaxBytes: readPositiveInt(env.VISION_HISTORY_MAX_BYTES, 8_388_608),
    companionModels: parseCompanionModelsJson(env.COMPANION_MODELS_JSON),
  }
}