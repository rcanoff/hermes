import { describe, expect, it } from 'vitest'
import { parseHealthDate, validateHealthMetrics } from '../src/lib/health-metrics.js'

describe('parseHealthDate', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(parseHealthDate('2026-06-17')).toBe('2026-06-17')
  })

  it('rejects invalid dates', () => {
    expect(parseHealthDate('06-17-2026')).toBeNull()
    expect(parseHealthDate('')).toBeNull()
  })
})

describe('validateHealthMetrics', () => {
  it('accepts steps with matching remaining', () => {
    const result = validateHealthMetrics({
      steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
    })
    expect(result).toEqual({
      steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
    })
  })

  it('rejects remaining mismatch when goal is set', () => {
    expect(
      validateHealthMetrics({
        steps: { value: 100, unit: 'count', goal: 1000, remaining: 500 },
      }),
    ).toBeNull()
  })

  it('requires remaining null when goal is null', () => {
    expect(
      validateHealthMetrics({
        steps: { value: 100, unit: 'count', goal: null, remaining: 0 },
      }),
    ).toBeNull()
  })
})