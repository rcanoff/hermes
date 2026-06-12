import { buildApp } from '../../src/app.js'

export async function createTestApp() {
  return buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    hermesBaseUrl: 'http://hermes.test',
    bootstrapUsername: 'operator',
    bootstrapPassword: 'password123',
  })
}
