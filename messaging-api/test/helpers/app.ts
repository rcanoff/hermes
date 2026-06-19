import { buildApp } from '../../src/app.js'
import type { AppOptions } from '../../src/types.js'

const defaultApns = {
  enabled: false,
  teamId: '',
  keyId: '',
  bundleId: '',
  keyPath: '',
  environment: 'development' as const,
  previewMaxChars: 120,
}

export async function createTestApp(overrides: Partial<AppOptions> = {}) {
  return buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    hermesBaseUrl: 'http://hermes.test',
    hermesApiKey: 'test-api-key',
    messagingApiHost: '127.0.0.1:3000',
    inviteExpiryHours: 48,
    minPasswordLength: 12,
    companionMcpBearerToken: 'test-mcp-token',
    cronWebhookBearer: 'test-cron-webhook-bearer',
    cronOutputDir: '/tmp/hermes-cron-output-test',
    cronJobsPath: '/tmp/hermes-cron-jobs-test.json',
    cronOutputPollMs: 5,
    addressEnrichmentSessionId: 'companion-address-enrichment',
    apns: defaultApns,
    syncInboxMaxGap: 500,
    ...overrides,
  })
}