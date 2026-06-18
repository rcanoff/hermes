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

describe('validateHealthMetrics v2', () => {
  it('accepts sleep and heart metrics', () => {
    const result = validateHealthMetrics({
      sleep_duration: { value: 420, unit: 'min', goal: null, remaining: null },
      resting_heart_rate: { value: 58, unit: 'bpm', goal: null, remaining: null },
    })
    expect(result).toEqual({
      sleep_duration: { value: 420, unit: 'min', goal: null, remaining: null },
      resting_heart_rate: { value: 58, unit: 'bpm', goal: null, remaining: null },
    })
  })

  it('accepts workout_types alongside scalar metrics', () => {
    const result = validateHealthMetrics({
      workout_count: { value: 2, unit: 'count', goal: null, remaining: null },
      workout_types: { types: ['running', 'walking'] },
    })
    expect(result?.workout_count?.value).toBe(2)
    expect(result?.workout_types).toEqual({ types: ['running', 'walking'] })
  })

  it('rejects invalid workout_types slug', () => {
    expect(
      validateHealthMetrics({
        workout_types: { types: ['Running'] },
      }),
    ).toBeNull()
  })

  it('rejects unknown metric keys', () => {
    expect(
      validateHealthMetrics({
        steps: { value: 100, unit: 'count', goal: null, remaining: null },
        heart_rate_samples: { value: 1, unit: 'count', goal: null, remaining: null },
      }),
    ).toBeNull()
  })

  it('accepts v1-only payload (regression)', () => {
    const result = validateHealthMetrics({
      steps: { value: 1000, unit: 'count', goal: 10000, remaining: 9000 },
    })
    expect(result?.steps?.value).toBe(1000)
  })
})