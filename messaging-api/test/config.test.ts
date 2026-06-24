import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TITLE_GENERATION_OPENAI_MODEL,
  DEFAULT_TITLE_GENERATION_XAI_BASE_URL,
  DEFAULT_TITLE_GENERATION_XAI_MODEL,
  readConfig,
} from '../src/config.js'

describe('readConfig', () => {
  it('fails when JWT_SECRET is missing', () => {
    expect(() =>
      readConfig({
        HERMES_BASE_URL: 'http://hermes:8642',
      }),
    ).toThrow('JWT_SECRET is required')
  })

  it('fails when MESSAGING_API_HOST is missing', () => {
    expect(() =>
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
      }),
    ).toThrow('MESSAGING_API_HOST is required')
  })

  it('returns config when required values are present', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
      }),
    ).toEqual({
      dbPath: '/opt/data/messaging-api.sqlite',
      jwtSecret: 'test-secret',
      hermesBaseUrl: 'http://hermes:8642',
      hermesApiKey: '',
      messagingApiHost: '100.64.0.1:3000',
      inviteExpiryHours: 48,
      minPasswordLength: 12,
      companionMcpBearerToken: '',
      cronWebhookBearer: '',
      cronOutputDir: '/opt/data/cron/output',
      cronJobsPath: '/opt/data/cron/jobs.json',
      hermesStateDbPath: '/opt/data/state.db',
      cronOutputPollMs: 5,
      addressEnrichmentSessionId: 'companion-address-enrichment',
      titleGeneration: {
        providers: [],
        timeoutMs: 30_000,
      },
      cronPromptSynthesis: {
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.4',
        timeoutMs: 60_000,
      },
      apns: {
        enabled: false,
        teamId: '',
        keyId: '',
        bundleId: '',
        keyPath: '',
        environment: 'development',
        previewMaxChars: 120,
      },
      syncInboxMaxGap: 500,
      attachmentsDir: '/opt/data/attachments',
      attachmentMaxBytes: 20_971_520,
      attachmentOrphanTtlHours: 24,
      visionMaxEdgePx: 1536,
      thumbMaxEdgePx: 200,
      visionHistoryMaxBytes: 8_388_608,
    })
  })

  it('parses SYNC_INBOX_MAX_GAP with default 500', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
      }).syncInboxMaxGap,
    ).toBe(500)
  })

  it('builds title generation provider cascade when both API keys are present', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
        XAI_API_KEY: 'xai-test',
        OPENAI_API_KEY: 'sk-test',
        OPENAI_BASE_URL: 'https://proxy.example/v1',
        TITLE_GENERATION_TIMEOUT_MS: '45000',
      }).titleGeneration,
    ).toEqual({
      providers: [
        {
          apiKey: 'xai-test',
          baseUrl: DEFAULT_TITLE_GENERATION_XAI_BASE_URL,
          model: DEFAULT_TITLE_GENERATION_XAI_MODEL,
          timeoutMs: 45_000,
        },
        {
          apiKey: 'sk-test',
          baseUrl: 'https://proxy.example/v1',
          model: DEFAULT_TITLE_GENERATION_OPENAI_MODEL,
          timeoutMs: 45_000,
        },
      ],
      timeoutMs: 45_000,
    })
  })

  it('builds a single OpenAI provider when only OpenAI key is present', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
        OPENAI_API_KEY: 'sk-test',
        TITLE_GENERATION_OPENAI_MODEL: 'gpt-5.4-nano',
      }).titleGeneration,
    ).toEqual({
      providers: [
        {
          apiKey: 'sk-test',
          baseUrl: '',
          model: 'gpt-5.4-nano',
          timeoutMs: 30_000,
        },
      ],
      timeoutMs: 30_000,
    })
  })

  it('returns empty title providers when no API keys are configured', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
      }).titleGeneration,
    ).toEqual({
      providers: [],
      timeoutMs: 30_000,
    })
  })

  it('parses SYNC_INBOX_MAX_GAP override', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
        SYNC_INBOX_MAX_GAP: '250',
      }).syncInboxMaxGap,
    ).toBe(250)
  })

  it('parses APNS_ENABLED false by default', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
      }).apns.enabled,
    ).toBe(false)
  })

  it('requires APNS fields when enabled', () => {
    expect(() =>
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
        APNS_ENABLED: 'true',
      }),
    ).toThrow(/APNS_TEAM_ID/)
  })
})