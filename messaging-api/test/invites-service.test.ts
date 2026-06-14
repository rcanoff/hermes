import { describe, expect, it } from 'vitest'
import {
  buildInviteUrl,
  generateInviteToken,
  hashInviteToken,
  isUsernameValid,
  validatePassword,
} from '../src/services/invites.js'

describe('invite service', () => {
  it('generates url-safe tokens and stable hashes', () => {
    const raw = generateInviteToken()
    expect(raw.length).toBeGreaterThan(30)
    expect(hashInviteToken(raw)).toHaveLength(64)
  })

  it('builds invite urls from host and token', () => {
    expect(buildInviteUrl('100.64.0.1:3000', 'abc123')).toBe(
      'http://100.64.0.1:3000/invite/abc123',
    )
  })

  it('validates usernames', () => {
    expect(isUsernameValid('roberto')).toBe(true)
    expect(isUsernameValid('ab')).toBe(false)
    expect(isUsernameValid('bad name')).toBe(false)
  })

  it('validates password length', () => {
    expect(validatePassword('short', 12)).toEqual({ ok: false })
    expect(validatePassword('long-enough-pass', 12)).toEqual({ ok: true })
  })
})