import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TITLE_GENERATION_PROVIDERS,
  readConfig,
} from '../src/config.js'
import { DEFAULT_COMPANION_MODELS } from '../src/lib/companion-models.js'

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
        bridgeUrl: '',
        bridgeApiKey: '',
        providers: DEFAULT_TITLE_GENERATION_PROVIDERS,
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
      companionModels: DEFAULT_COMPANION_MODELS,
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

  it('reads Hermes auxiliary bridge settings for title generation', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
        HERMES_AUXILIARY_BRIDGE_URL: 'http://hermes-auxiliary-bridge:8750',
        HERMES_API_KEY: 'bridge-key',
        TITLE_GENERATION_TIMEOUT_MS: '45000',
      }).titleGeneration,
    ).toEqual({
      bridgeUrl: 'http://hermes-auxiliary-bridge:8750',
      bridgeApiKey: 'bridge-key',
      providers: DEFAULT_TITLE_GENERATION_PROVIDERS,
      timeoutMs: 45_000,
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

  it('loads companion models from provider cache file when env json is unset', () => {
    const cachePath = '/tmp/hermes-provider-models-test-cache.json'
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        'xai-oauth': { models: ['grok-composer-2.5-fast', 'grok-4.3'] },
      }),
    )

    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
        PROVIDER_MODELS_CACHE_PATH: cachePath,
      }).companionModels,
    ).toEqual([
      {
        model: 'grok-composer-2.5-fast',
        provider: 'xai-oauth',
        display: 'grok-composer-2.5-fast',
        subtitle: 'xAI Grok OAuth (SuperGrok / Premium+)',
      },
      {
        model: 'grok-4.3',
        provider: 'xai-oauth',
        display: 'grok-4.3',
        subtitle: 'xAI Grok OAuth (SuperGrok / Premium+)',
      },
    ])

    fs.rmSync(cachePath, { force: true })
  })

  it('parses COMPANION_MODELS_JSON override', () => {
    const custom = [
      {
        model: 'custom-model',
        provider: 'custom-provider',
        display: 'Custom',
      },
    ]
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
        COMPANION_MODELS_JSON: JSON.stringify(custom),
      }).companionModels,
    ).toEqual(custom)
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