import { describe, expect, it } from 'vitest'
import {
  COMPANION_CRON_DEFAULT_MODEL,
  COMPANION_CRON_DEFAULT_PROVIDER,
  companionCronModelPatch,
} from '../src/lib/companion-cron-model.js'

describe('companion-cron-model', () => {
  it('patches unset model/provider to xai-oauth grok-composer-2.5-fast', () => {
    expect(companionCronModelPatch({ model: null, provider: null })).toEqual({
      model: COMPANION_CRON_DEFAULT_MODEL,
      provider: COMPANION_CRON_DEFAULT_PROVIDER,
    })
    expect(COMPANION_CRON_DEFAULT_MODEL).toBe('grok-composer-2.5-fast')
    expect(COMPANION_CRON_DEFAULT_PROVIDER).toBe('xai-oauth')
  })

  it('upgrades legacy openai-api defaults', () => {
    expect(
      companionCronModelPatch({ model: 'gpt-5.4-mini', provider: 'openai-api' }),
    ).toEqual({
      model: COMPANION_CRON_DEFAULT_MODEL,
      provider: COMPANION_CRON_DEFAULT_PROVIDER,
    })
    expect(
      companionCronModelPatch({ model: 'gpt-5.4', provider: 'openai-api' }),
    ).toEqual({
      model: COMPANION_CRON_DEFAULT_MODEL,
      provider: COMPANION_CRON_DEFAULT_PROVIDER,
    })
  })

  it('leaves explicit non-legacy models unchanged', () => {
    expect(
      companionCronModelPatch({
        model: 'grok-composer-2.5-fast',
        provider: 'xai-oauth',
      }),
    ).toBeNull()
    expect(
      companionCronModelPatch({ model: 'claude-sonnet-4', provider: 'anthropic' }),
    ).toBeNull()
  })
})