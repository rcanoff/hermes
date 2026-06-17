import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { HealthMetrics } from '../../lib/health-metrics.js'
import type { ListPageAnchors } from './conversations.js'

export interface HealthDailySummaryRow {
  id: string
  user_id: string
  date: string
  timezone: string
  partial: number
  finalized_at: string | null
  synced_at: string
  source: string
  metrics_json: string
  created_at: string
  updated_at: string
}

export interface UpsertHealthDailySummaryInput {
  userId: string
  date: string
  timezone: string
  partial: boolean
  source: string
  metrics: HealthMetrics
}

export interface HealthDailySummaryPage {
  summaries: HealthDailySummaryRow[]
  hasOlder: boolean
  hasNewer: boolean
}

export class DayFinalizedError extends Error {
  constructor() {
    super('day_finalized')
  }
}

export function upsertHealthDailySummary(
  db: Database.Database,
  input: UpsertHealthDailySummaryInput,
): HealthDailySummaryRow {
  const existing = db
    .prepare(`SELECT * FROM health_daily_summaries WHERE user_id = ? AND date = ?`)
    .get(input.userId, input.date) as HealthDailySummaryRow | undefined

  const metricsJson = JSON.stringify(input.metrics)
  const partialInt = input.partial ? 1 : 0

  if (existing) {
    if (existing.partial === 0 && input.partial) {
      throw new DayFinalizedError()
    }

    if (existing.partial === 0 && !input.partial) {
      db.prepare(`
        UPDATE health_daily_summaries
        SET timezone = ?,
            partial = 0,
            synced_at = datetime('now'),
            source = ?,
            metrics_json = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(input.timezone, input.source, metricsJson, existing.id)
    } else {
      db.prepare(`
        UPDATE health_daily_summaries
        SET timezone = ?,
            partial = ?,
            finalized_at = CASE WHEN ? = 0 THEN COALESCE(finalized_at, datetime('now')) ELSE NULL END,
            synced_at = datetime('now'),
            source = ?,
            metrics_json = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(input.timezone, partialInt, partialInt, input.source, metricsJson, existing.id)
    }

    return getHealthDailySummaryById(db, existing.id)!
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO health_daily_summaries (
      id, user_id, date, timezone, partial, finalized_at, source, metrics_json
    ) VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 0 THEN datetime('now') ELSE NULL END, ?, ?)
  `).run(id, input.userId, input.date, input.timezone, partialInt, partialInt, input.source, metricsJson)

  return getHealthDailySummaryById(db, id)!
}

export function getHealthDailySummaryById(
  db: Database.Database,
  id: string,
): HealthDailySummaryRow | undefined {
  return db
    .prepare(`SELECT * FROM health_daily_summaries WHERE id = ?`)
    .get(id) as HealthDailySummaryRow | undefined
}

export function getLatestHealthDailySummary(
  db: Database.Database,
  userId: string,
): HealthDailySummaryRow | undefined {
  return db
    .prepare(`
      SELECT * FROM health_daily_summaries
      WHERE user_id = ?
      ORDER BY date DESC, id DESC
      LIMIT 1
    `)
    .get(userId) as HealthDailySummaryRow | undefined
}

export function getHealthDailySummaryByDate(
  db: Database.Database,
  userId: string,
  date: string,
): HealthDailySummaryRow | undefined {
  return db
    .prepare(`SELECT * FROM health_daily_summaries WHERE user_id = ? AND date = ?`)
    .get(userId, date) as HealthDailySummaryRow | undefined
}

export function getHealthDailySummaryForUser(
  db: Database.Database,
  userId: string,
  id: string,
): HealthDailySummaryRow | undefined {
  return db
    .prepare(`SELECT * FROM health_daily_summaries WHERE user_id = ? AND id = ?`)
    .get(userId, id) as HealthDailySummaryRow | undefined
}

export function listHealthDailySummariesPage(
  db: Database.Database,
  userId: string,
  limit: number,
  anchors: ListPageAnchors = {},
): HealthDailySummaryPage | null {
  if (anchors.before) {
    const cursor = getHealthDailySummaryForUser(db, userId, anchors.before)
    if (!cursor) {
      return null
    }

    const summaries = db
      .prepare(`
        SELECT * FROM health_daily_summaries
        WHERE user_id = ?
          AND (
            date < ?
            OR (date = ? AND id < ?)
          )
        ORDER BY date DESC, id DESC
        LIMIT ?
      `)
      .all(userId, cursor.date, cursor.date, cursor.id, limit) as HealthDailySummaryRow[]

    return buildHealthDailySummaryPage(db, userId, summaries)
  }

  if (anchors.after) {
    const cursor = getHealthDailySummaryForUser(db, userId, anchors.after)
    if (!cursor) {
      return null
    }

    const summaries = db
      .prepare(`
        SELECT * FROM health_daily_summaries
        WHERE user_id = ?
          AND (
            date > ?
            OR (date = ? AND id > ?)
          )
        ORDER BY date ASC, id ASC
        LIMIT ?
      `)
      .all(userId, cursor.date, cursor.date, cursor.id, limit) as HealthDailySummaryRow[]

    summaries.reverse()
    return buildHealthDailySummaryPage(db, userId, summaries)
  }

  const summaries = db
    .prepare(`
      SELECT * FROM health_daily_summaries
      WHERE user_id = ?
      ORDER BY date DESC, id DESC
      LIMIT ?
    `)
    .all(userId, limit) as HealthDailySummaryRow[]

  return buildHealthDailySummaryPage(db, userId, summaries)
}

export function parseStoredHealthMetrics(metricsJson: string): HealthMetrics {
  return JSON.parse(metricsJson) as HealthMetrics
}

function buildHealthDailySummaryPage(
  db: Database.Database,
  userId: string,
  summaries: HealthDailySummaryRow[],
): HealthDailySummaryPage {
  if (summaries.length === 0) {
    return {
      summaries,
      hasOlder: false,
      hasNewer: false,
    }
  }

  const first = summaries[0]!
  const last = summaries[summaries.length - 1]!

  const hasNewer = db
    .prepare(`
      SELECT 1
      FROM health_daily_summaries
      WHERE user_id = ?
        AND (
          date > ?
          OR (date = ? AND id > ?)
        )
      LIMIT 1
    `)
    .get(userId, first.date, first.date, first.id) as { 1: number } | undefined

  const hasOlder = db
    .prepare(`
      SELECT 1
      FROM health_daily_summaries
      WHERE user_id = ?
        AND (
          date < ?
          OR (date = ? AND id < ?)
        )
      LIMIT 1
    `)
    .get(userId, last.date, last.date, last.id) as { 1: number } | undefined

  return {
    summaries,
    hasOlder: hasOlder !== undefined,
    hasNewer: hasNewer !== undefined,
  }
}