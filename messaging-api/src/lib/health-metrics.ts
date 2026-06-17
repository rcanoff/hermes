const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const METRIC_KEYS = [
  'steps',
  'distance_walking_running',
  'active_energy',
  'exercise_minutes',
  'stand_hours',
] as const

const UNITS = new Set(['count', 'm', 'kcal', 'min', 'h'])

export interface HealthMetric {
  value: number
  unit: 'count' | 'm' | 'kcal' | 'min' | 'h'
  goal: number | null
  remaining: number | null
}

export type HealthMetrics = Partial<Record<(typeof METRIC_KEYS)[number], HealthMetric>>

export function parseHealthDate(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    return null
  }
  return value
}

export function validateHealthMetrics(value: unknown): HealthMetrics | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const metrics: HealthMetrics = {}
  let count = 0

  for (const key of METRIC_KEYS) {
    const raw = (value as Record<string, unknown>)[key]
    if (raw === undefined) {
      continue
    }

    const metric = parseMetric(raw)
    if (!metric) {
      return null
    }

    metrics[key] = metric
    count += 1
  }

  return count > 0 ? metrics : null
}

function parseMetric(value: unknown): HealthMetric | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const raw = value as Record<string, unknown>
  const numValue = raw.value
  const unit = raw.unit
  const goal = raw.goal
  const remaining = raw.remaining

  if (typeof numValue !== 'number' || numValue < 0 || !Number.isFinite(numValue)) {
    return null
  }
  if (typeof unit !== 'string' || !UNITS.has(unit)) {
    return null
  }

  if (goal === null) {
    if (remaining !== null) {
      return null
    }
    return { value: numValue, unit: unit as HealthMetric['unit'], goal: null, remaining: null }
  }

  if (typeof goal !== 'number' || goal < 0 || !Number.isFinite(goal)) {
    return null
  }
  if (typeof remaining !== 'number' || remaining < 0 || !Number.isFinite(remaining)) {
    return null
  }

  const expected = Math.max(0, goal - numValue)
  if (remaining !== expected) {
    return null
  }

  return { value: numValue, unit: unit as HealthMetric['unit'], goal, remaining }
}