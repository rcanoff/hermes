import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildApp } from '../../src/app.js'
import type { AppOptions } from '../../src/types.js'

const defaultAttachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-attachments-'))

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
    hermesStateDbPath: '/tmp/hermes-state-test.db',
    cronOutputPollMs: 5,
    addressEnrichmentSessionId: 'companion-address-enrichment',
    titleGeneration: {
      apiKey: '',
      baseUrl: '',
      model: 'grok-composer-2.5-fast',
      timeoutMs: 30_000,
    },
    cronPromptSynthesis: {
      apiKey: '',
      baseUrl: '',
      model: 'gpt-5.4',
      timeoutMs: 60_000,
    },
    apns: defaultApns,
    syncInboxMaxGap: 500,
    attachmentsDir: defaultAttachmentsDir,
    attachmentMaxBytes: 20_971_520,
    attachmentOrphanTtlHours: 24,
    visionMaxEdgePx: 1536,
    thumbMaxEdgePx: 200,
    visionHistoryMaxBytes: 8_388_608,
    ...overrides,
  })
}