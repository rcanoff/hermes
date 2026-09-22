import { describe, expect, it } from 'vitest'
import {
  buildGroupPrompt,
  GROUP_PROMPT_CHAR_BUDGET,
  GROUP_SYSTEM_PROMPT,
} from '../src/lib/group-prompt.js'

describe('buildGroupPrompt', () => {
  it('keeps the boundary reply and drops an older line before the primary request', () => {
    const older = 'OLD'.repeat(GROUP_PROMPT_CHAR_BUDGET)
    const result = buildGroupPrompt({
      botName: 'Homer',
      context: [
        { author: 'alice', text: older },
        { author: 'Homer', text: 'boundary reply' },
      ],
      primary: { username: 'bob', text: 'book the flight' },
    })

    const section = result.text.indexOf('Primary request from bob:')
    expect(result.fits).toBe(true)
    expect(result.text).toContain('Homer: boundary reply')
    expect(result.text).not.toContain('OLD')
    expect(section).toBeGreaterThan(0)
    expect(result.text.slice(0, section)).not.toContain('book the flight')
    expect(result.text.split('book the flight')).toHaveLength(2)
    expect(result.text.length).toBeLessThanOrEqual(GROUP_PROMPT_CHAR_BUDGET)
  })

  it('does not fit an oversized primary request', () => {
    const result = buildGroupPrompt({
      botName: 'Homer',
      context: [{ author: 'alice', text: 'keep-me' }],
      primary: { username: 'bob', text: 'p'.repeat(GROUP_PROMPT_CHAR_BUDGET) },
    })

    expect(GROUP_SYSTEM_PROMPT.length).toBeGreaterThan(0)
    expect(result.fits).toBe(false)
    expect(result.text).not.toContain('keep-me')
  })
})
