import { describe, expect, it } from 'vitest'
import {
  HERMES_RESERVED_PROFILE_NAMES,
  hermesProfileName,
} from '../src/lib/hermes-profile.js'

describe('hermesProfileName', () => {
  it('lowercases username and joins slug', () => {
    expect(hermesProfileName('AlineTusi', 'home-agent')).toEqual({ ok: true, name: 'alinetusi-home-agent' })
    expect(hermesProfileName('rcanoff', 'homer')).toEqual({ ok: true, name: 'rcanoff-homer' })
  })

  it('returns null for operator default (real home)', () => {
    expect(hermesProfileName('rcanoff', 'default')).toEqual({ ok: true, name: null })
  })

  it('allows other users default as prefixed name', () => {
    expect(hermesProfileName('AlineTusi', 'default')).toEqual({ ok: true, name: 'alinetusi-default' })
  })

  it('returns invalid_request when longer than 64', () => {
    const username = 'a'.repeat(32)
    const slug = 'b'.repeat(32)
    expect(hermesProfileName(username, slug)).toEqual({ ok: false, error: 'invalid_request' })
  })

  it('rejects entire-name reserved ids', () => {
    expect(hermesProfileName('hermes', 'x')).toEqual({ ok: true, name: 'hermes-x' })
    expect(HERMES_RESERVED_PROFILE_NAMES.has('hermes')).toBe(true)
    expect(HERMES_RESERVED_PROFILE_NAMES.has('hermes-x')).toBe(false)
  })
})
