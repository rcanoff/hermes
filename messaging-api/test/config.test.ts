import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'

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
      cronOutputPollMs: 5,
      addressEnrichmentSessionId: 'companion-address-enrichment',
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