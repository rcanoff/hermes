import { describe, expect, it } from 'vitest'
import {
  COMPANION_CRON_DEFAULT_MODEL,
  COMPANION_CRON_DEFAULT_PROVIDER,
  companionCronModelPatch,
} from '../src/lib/companion-cron-model.js'

describe('companion-cron-model', () => {
  it('patches unset model/provider to openai-api gpt-5.4', () => {
    expect(companionCronModelPatch({ model: null, provider: null })).toEqual({
      model: COMPANION_CRON_DEFAULT_MODEL,
      provider: COMPANION_CRON_DEFAULT_PROVIDER,
    })
  })

  it('upgrades gpt-5.4-mini to gpt-5.4', () => {
    expect(
      companionCronModelPatch({ model: 'gpt-5.4-mini', provider: 'openai-api' }),
    ).toEqual({
      model: COMPANION_CRON_DEFAULT_MODEL,
      provider: COMPANION_CRON_DEFAULT_PROVIDER,
    })
  })

  it('leaves explicit non-mini models unchanged', () => {
    expect(
      companionCronModelPatch({ model: 'gpt-5.4', provider: 'openai-api' }),
    ).toBeNull()
    expect(
      companionCronModelPatch({ model: 'claude-sonnet-4', provider: 'anthropic' }),
    ).toBeNull()
  })
})