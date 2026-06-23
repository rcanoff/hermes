import { describe, expect, it } from 'vitest'
import {
  buildHomeAssistantDigestCronPrompt,
  HOME_ASSISTANT_DIGEST_PROMPT_MARKER,
  inferCompanionCronJobKindHeuristic,
  isExplicitHomeAssistantDigestJob,
  needsHomeAssistantDigestPromptNormalization,
  normalizeHomeAssistantDigestPrompt,
} from '../src/lib/companion-cron-prompt.js'

describe('companion-cron-prompt', () => {
  it('builds HA digest prompt with mandatory tool-use rules', () => {
    expect(buildHomeAssistantDigestCronPrompt()).toContain(HOME_ASSISTANT_DIGEST_PROMPT_MARKER)
    expect(buildHomeAssistantDigestCronPrompt()).toContain('tool_search')
    expect(buildHomeAssistantDigestCronPrompt()).toContain('mcp_ha_ha_get_logs')
  })

  it('normalizes explicit recurring HA digest prompts', () => {
    expect(
      needsHomeAssistantDigestPromptNormalization({
        name: 'HA daily digest (yesterday)',
        prompt: 'Create a Home Assistant daily report for yesterday.',
        schedule_display: '30 9 * * *',
      }),
    ).toBe(true)
    expect(
      normalizeHomeAssistantDigestPrompt({
        name: 'HA daily digest (yesterday)',
        prompt: 'Create a Home Assistant daily report for yesterday.',
        schedule_display: '30 9 * * *',
      }),
    ).toBe(buildHomeAssistantDigestCronPrompt())
    expect(
      normalizeHomeAssistantDigestPrompt({
        name: 'HA daily digest (yesterday)',
        prompt: buildHomeAssistantDigestCronPrompt(),
        schedule_display: '30 9 * * *',
      }),
    ).toBeNull()
  })

  it('does not treat one-shot HA-topic reminders as digest jobs', () => {
    const bermudaJob = {
      name: 'Bermuda tuning follow-up',
      prompt:
        'Reminder: look into tuning Bermuda for the bedroom fan flicker. Check Bermuda settings in Home Assistant and adjust smoothing_samples.',
      schedule_display: 'once at 2026-06-22 19:00',
    }

    expect(isExplicitHomeAssistantDigestJob(bermudaJob)).toBe(false)
    expect(needsHomeAssistantDigestPromptNormalization(bermudaJob)).toBe(false)
    expect(normalizeHomeAssistantDigestPrompt(bermudaJob)).toBeNull()
    expect(
      inferCompanionCronJobKindHeuristic({
        ...bermudaJob,
        userTriggerMessage: 'remind me to look into that later at 7pm',
      }),
    ).toBe('reminder')
  })
})