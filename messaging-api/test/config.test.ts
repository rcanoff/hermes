import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'

describe('readConfig', () => {
  it('fails when required secrets are missing', () => {
    expect(() =>
      readConfig({
        HERMES_BASE_URL: 'http://hermes:8642',
      }),
    ).toThrow('JWT_SECRET is required')

    expect(() =>
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
      }),
    ).toThrow('BOOTSTRAP_PASSWORD is required')
  })

  it('returns config when required secrets are present', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        BOOTSTRAP_PASSWORD: 'test-password',
      }),
    ).toEqual({
      dbPath: '/opt/data/messaging-api.sqlite',
      jwtSecret: 'test-secret',
      hermesBaseUrl: 'http://hermes:8642',
      hermesApiKey: '',
      bootstrapUsername: 'operator',
      bootstrapPassword: 'test-password',
    })
  })
})
