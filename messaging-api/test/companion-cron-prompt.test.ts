import { describe, expect, it } from 'vitest'
import {
  buildReminderCronPrompt,
  buildRichReminderCronPrompt,
  extractReminderLabel,
  isCompanionReminderTemplate,
  needsReminderPromptNormalization,
  normalizeCompanionReminderPrompt,
} from '../src/lib/companion-cron-prompt.js'

const BRUSSELS_ROUTE_BODY = `Reminder: Go to Brussels.

\`\`\`map
type: route
title: Berlin to Brussels
transport: driving
origin:
  name: Berlin
  latitude: 52.52
  longitude: 13.405
destination:
  name: Brussels
  latitude: 50.8503
  longitude: 4.3517
\`\`\`

[Open in Apple Maps](https://maps.apple.com/?saddr=Berlin&daddr=Brussels&dirflg=d)`

describe('companion-cron-prompt', () => {
  it('builds a literal-output reminder template', () => {
    expect(buildReminderCronPrompt('Get water.')).toBe(
      `Scheduled reminder only. Your entire response must be exactly one line:

Reminder: Get water.

No tools. No other text, steps, or narration.`,
    )
  })

  it('builds a rich literal-output reminder template', () => {
    expect(buildRichReminderCronPrompt(BRUSSELS_ROUTE_BODY)).toBe(
      `Scheduled reminder only. Your entire response must match the following message exactly (including fences and links). Do not add, remove, or rephrase anything:

${BRUSSELS_ROUTE_BODY}

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

  it('accepts an already-normalized simple prompt', () => {
    expect(needsReminderPromptNormalization(buildReminderCronPrompt('Get water.'))).toBe(false)
  })

  it('accepts an already-normalized rich prompt', () => {
    expect(needsReminderPromptNormalization(buildRichReminderCronPrompt(BRUSSELS_ROUTE_BODY))).toBe(
      false,
    )
  })

  it('skips normalization when prompt contains a map block', () => {
    expect(
      needsReminderPromptNormalization(
        'Send the user this reminder with the route:\n\n```map\ntype: route\n```',
      ),
    ).toBe(false)
  })

  it('detects companion reminder templates', () => {
    expect(isCompanionReminderTemplate(buildReminderCronPrompt('Get water.'))).toBe(true)
    expect(isCompanionReminderTemplate(buildRichReminderCronPrompt(BRUSSELS_ROUTE_BODY))).toBe(true)
    expect(isCompanionReminderTemplate('Send a reminder to get water.')).toBe(false)
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

  it('does not normalize rich prompts with map blocks', () => {
    expect(
      normalizeCompanionReminderPrompt({
        name: 'Go to Brussels reminder with route',
        prompt: buildRichReminderCronPrompt(BRUSSELS_ROUTE_BODY),
      }),
    ).toBeNull()
  })
})