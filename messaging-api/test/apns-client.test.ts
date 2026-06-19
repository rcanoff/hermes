import { describe, expect, it } from 'vitest'
import {
  apnsHost,
  buildApnsJwt,
  createTestApnsPrivateKeyPem,
} from '../src/services/apns-client.js'

describe('apns client helpers', () => {
  it('selects sandbox host for development', () => {
    expect(apnsHost('development')).toBe('api.sandbox.push.apple.com')
  })

  it('selects production host for production', () => {
    expect(apnsHost('production')).toBe('api.push.apple.com')
  })

  it('buildApnsJwt returns three dot-separated segments', () => {
    const jwt = buildApnsJwt({
      teamId: 'TEAM',
      keyId: 'KEY',
      privateKeyPem: createTestApnsPrivateKeyPem(),
      issuedAt: 1_700_000_000,
    })
    expect(jwt.split('.')).toHaveLength(3)
  })
})