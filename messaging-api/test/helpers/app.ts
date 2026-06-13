import { buildApp } from '../../src/app.js'
import type { AppOptions } from '../../src/types.js'

export async function createTestApp(overrides: Partial<AppOptions> = {}) {
  return buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    hermesBaseUrl: 'http://hermes.test',
    hermesApiKey: 'test-api-key',
    bootstrapUsername: 'operator',
    bootstrapPassword: 'password123',
    ...overrides,
  })
}
