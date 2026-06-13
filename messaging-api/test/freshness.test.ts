import { describe, expect, it } from 'vitest'
import { formatFreshness } from '../src/services/freshness.js'

describe('formatFreshness', () => {
  it('returns "just now" for under 60 seconds', () => {
    const now = new Date('2026-06-13T10:00:00.000Z')
    expect(formatFreshness('2026-06-13T09:59:30.000Z', now)).toBe('just now')
  })

  it('returns minutes ago', () => {
    const now = new Date('2026-06-13T10:00:00.000Z')
    expect(formatFreshness('2026-06-13T09:48:00.000Z', now)).toBe('12 min ago')
  })
})