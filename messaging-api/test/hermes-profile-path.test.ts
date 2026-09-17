import { describe, expect, it } from 'vitest'
import { hermesProfileKeyForBot, type BotRow } from '../src/db/repos/bots.js'
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

  it('prefixes official hyphenated names as one segment', () => {
    expect(hermesProfilePath('/v1/chat/completions', 'alinetusi-home-agent')).toBe(
      '/p/alinetusi-home-agent/v1/chat/completions',
    )
    expect(hermesProfilePath('/api/sessions', 'alinetusi-travel')).toBe(
      '/p/alinetusi-travel/api/sessions',
    )
  })
})

describe('hermesProfileKeyForBot', () => {
  function bot(overrides: Partial<BotRow>): BotRow {
    return {
      id: 'b1',
      user_id: 'u1',
      slug: 'default',
      name: 'Hermes',
      role: 'Default',
      soul: 'soul',
      responsibilities: '',
      icon: 'message',
      color: 'blue',
      runtime: 'hermes',
      hermes_profile_name: null,
      is_default: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      owner_username: 'rcanoff',
      ...overrides,
    }
  }

  it('returns the stored official profile name', () => {
    expect(
      hermesProfileKeyForBot(
        bot({
          slug: 'home-agent',
          hermes_profile_name: 'alinetusi-home-agent',
          owner_username: 'AlineTusi',
          is_default: 0,
        }),
      ),
    ).toBe('alinetusi-home-agent')
  })

  it('returns undefined for operator default (null name → unprefixed)', () => {
    expect(hermesProfileKeyForBot(bot({ hermes_profile_name: null }))).toBeUndefined()
  })

  it('returns undefined for grok bots', () => {
    expect(
      hermesProfileKeyForBot(
        bot({
          slug: 'grok',
          runtime: 'grok',
          hermes_profile_name: null,
          is_default: 0,
        }),
      ),
    ).toBeUndefined()
  })
})
