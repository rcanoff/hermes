import { buildApp } from '../../src/app.js'
import type { AppOptions } from '../../src/types.js'

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
    addressEnrichmentSessionId: 'companion-address-enrichment',
    ...overrides,
  })
}