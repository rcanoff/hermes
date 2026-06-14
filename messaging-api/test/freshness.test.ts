import { describe, expect, it } from 'vitest'
import { formatFreshness } from '../src/services/freshness.js'

describe('formatFreshness', () => {
  const now = new Date('2026-06-13T10:00:00.000Z')

  it('returns "just now" for under 60 seconds', () => {
    expect(formatFreshness('2026-06-13T09:59:30.000Z', now)).toBe('just now')
  })

  it('returns minutes for under 60 minutes', () => {
    expect(formatFreshness('2026-06-13T09:48:00.000Z', now)).toBe('12 min ago')
    expect(formatFreshness('2026-06-13T09:59:00.000Z', now)).toBe('1 min ago')
  })

  it('returns hours for 60 minutes up to 23 hours', () => {
    expect(formatFreshness('2026-06-13T09:00:00.000Z', now)).toBe('1 hour ago')
    expect(formatFreshness('2026-06-13T02:00:00.000Z', now)).toBe('8 hours ago')
    expect(formatFreshness('2026-06-12T11:00:00.000Z', now)).toBe('23 hours ago')
  })

  it('returns days for 24 hours or more', () => {
    expect(formatFreshness('2026-06-12T10:00:00.000Z', now)).toBe('1 day ago')
    expect(formatFreshness('2026-06-10T10:00:00.000Z', now)).toBe('3 days ago')
  })
})