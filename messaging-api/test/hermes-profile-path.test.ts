import { describe, expect, it } from 'vitest'
import { hermesProfilePath } from '../src/services/hermes-client.js'

describe('hermesProfilePath', () => {
  it('leaves default and missing slugs unprefixed', () => {
    expect(hermesProfilePath('/v1/chat/completions')).toBe('/v1/chat/completions')
    expect(hermesProfilePath('/v1/chat/completions', undefined)).toBe('/v1/chat/completions')
    expect(hermesProfilePath('/v1/chat/completions', null)).toBe('/v1/chat/completions')
    expect(hermesProfilePath('/v1/chat/completions', 'default')).toBe('/v1/chat/completions')
    expect(hermesProfilePath('/api/sessions', 'default')).toBe('/api/sessions')
  })

  it('prefixes non-default slugs for chat and session routes', () => {
    expect(hermesProfilePath('/v1/chat/completions', 'travel')).toBe('/p/travel/v1/chat/completions')
    expect(hermesProfilePath('/api/sessions', 'travel')).toBe('/p/travel/api/sessions')
    expect(hermesProfilePath('v1/chat/completions', 'research')).toBe('/p/research/v1/chat/completions')
  })

  it('prefixes namespaced user profile keys', () => {
    expect(hermesProfilePath('/v1/chat/completions', 'user-aline/default')).toBe(
      '/p/user-aline/default/v1/chat/completions',
    )
    expect(hermesProfilePath('/api/sessions', 'user-aline/travel')).toBe(
      '/p/user-aline/travel/api/sessions',
    )
  })
})
