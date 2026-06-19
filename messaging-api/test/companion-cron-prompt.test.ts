import { describe, expect, it } from 'vitest'
import {
  buildReminderCronPrompt,
  extractReminderLabel,
  needsReminderPromptNormalization,
  normalizeCompanionReminderPrompt,
} from '../src/lib/companion-cron-prompt.js'

describe('companion-cron-prompt', () => {
  it('builds a literal-output reminder template', () => {
    expect(buildReminderCronPrompt('Get water.')).toBe(
      `Scheduled reminder only. Your entire response must be exactly one line:

Reminder: Get water.

No tools. No other text, steps, or narration.`,
    )
  })

  it('flags send-to-user wording as needing normalization', () => {
    expect(
      needsReminderPromptNormalization(
        'Send a reminder to get water to the current conversation user.',
      ),
    ).toBe(true)
  })

  it('accepts an already-normalized prompt', () => {
    expect(needsReminderPromptNormalization(buildReminderCronPrompt('Get water.'))).toBe(false)
  })

  it('extracts reminder label from job name', () => {
    expect(extractReminderLabel({ name: 'Get water reminder' })).toBe('Get water')
  })

  it('normalizes bad prompts using the job name', () => {
    expect(
      normalizeCompanionReminderPrompt({
        name: 'Get water reminder',
        prompt: 'Send a reminder to get water to the current conversation user.',
      }),
    ).toBe(buildReminderCronPrompt('Get water'))
  })
})