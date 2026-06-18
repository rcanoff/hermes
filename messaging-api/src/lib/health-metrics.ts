const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const METRIC_KEYS = [
  'steps',
  'distance_walking_running',
  'active_energy',
  'exercise_minutes',
  'stand_hours',
  'flights_climbed',
  'sleep_duration',
  'sleep_in_bed',
  'sleep_deep',
  'sleep_rem',
  'sleep_core',
  'resting_heart_rate',
  'heart_rate_avg',
  'hrv_sdnn',
  'workout_count',
  'workout_minutes',
  'weight',
  'bmi',
  'body_fat_percentage',
  'dietary_energy',
  'protein',
  'water',
  'mindfulness_minutes',
] as const

const UNITS = new Set(['count', 'm', 'kcal', 'min', 'h', 'bpm', 'ms', 'kg', 'pct', 'g', 'ml'])

const WORKOUT_TYPE_SLUG_RE = /^[a-z][a-z0-9_]*$/

export interface HealthWorkoutTypes {
  types: string[]
}

export type HealthMetricUnit =
  | 'count'
  | 'm'
  | 'kcal'
  | 'min'
  | 'h'
  | 'bpm'
  | 'ms'
  | 'kg'
  | 'pct'
  | 'g'
  | 'ml'

export interface HealthMetric {
  value: number
  unit: HealthMetricUnit
  goal: number | null
  remaining: number | null
}

export type HealthMetrics = Partial<Record<(typeof METRIC_KEYS)[number], HealthMetric>> & {
  workout_types?: HealthWorkoutTypes
}

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

  const raw = value as Record<string, unknown>
  const metrics: HealthMetrics = {}
  let count = 0

  for (const key of METRIC_KEYS) {
    const entry = raw[key]
    if (entry === undefined) {
      continue
    }
    const metric = parseMetric(entry)
    if (!metric) {
      return null
    }
    metrics[key] = metric
    count += 1
  }

  if (raw.workout_types !== undefined) {
    const workoutTypes = parseWorkoutTypes(raw.workout_types)
    if (!workoutTypes) {
      return null
    }
    metrics.workout_types = workoutTypes
    count += 1
  }

  for (const key of Object.keys(raw)) {
    if (key === 'workout_types') {
      continue
    }
    if (!(METRIC_KEYS as readonly string[]).includes(key)) {
      return null
    }
  }

  return count > 0 ? metrics : null
}

function parseWorkoutTypes(value: unknown): HealthWorkoutTypes | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const types = (value as Record<string, unknown>).types
  if (!Array.isArray(types) || types.length === 0 || types.length > 20) {
    return null
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const item of types) {
    if (typeof item !== 'string' || !WORKOUT_TYPE_SLUG_RE.test(item)) {
      return null
    }
    if (seen.has(item)) {
      return null
    }
    seen.add(item)
    normalized.push(item)
  }
  return { types: normalized }
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
    return { value: numValue, unit: unit as HealthMetricUnit, goal: null, remaining: null }
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

  return { value: numValue, unit: unit as HealthMetricUnit, goal, remaining }
}