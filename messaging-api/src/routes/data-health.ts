import type { FastifyPluginAsync } from 'fastify'
import {
  DayFinalizedError,
  getLatestHealthDailySummary,
  listHealthDailySummariesPage,
  parseStoredHealthMetrics,
  upsertHealthDailySummary,
  type HealthDailySummaryRow,
} from '../db/repos/health-daily-summaries.js'
import {
  describeHealthMetricsValidationFailure,
  parseHealthDate,
  validateHealthMetrics,
} from '../lib/health-metrics.js'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'

const VALID_SOURCES = new Set(['healthkit'])

interface UpsertHealthDailySummaryBody {
  date: string
  timezone: string
  partial: boolean
  source: string
  metrics: ReturnType<typeof validateHealthMetrics>
}

const dataHealthRoutes: FastifyPluginAsync = async (app) => {
  app.post('/data/health/daily-summaries', { preHandler: app.authenticate }, async (request, reply) => {
    const body = parseUpsertBody(request.body)
    if (!body) {
      const reasons = describeUpsertBodyFailure(request.body)
      app.log.warn(
        {
          userId: request.userId,
          reasons,
          metricKeys:
            typeof request.body === 'object' && request.body !== null && 'metrics' in request.body
              ? Object.keys((request.body as { metrics?: Record<string, unknown> }).metrics ?? {})
              : [],
          date:
            typeof request.body === 'object' && request.body !== null && 'date' in request.body
              ? (request.body as { date?: unknown }).date
              : undefined,
          partialType:
            typeof request.body === 'object' && request.body !== null && 'partial' in request.body
              ? typeof (request.body as { partial?: unknown }).partial
              : undefined,
          source:
            typeof request.body === 'object' && request.body !== null && 'source' in request.body
              ? (request.body as { source?: unknown }).source
              : undefined,
        },
        'health daily summary upsert rejected',
      )
      return reply.code(400).send({ error: 'invalid_request' })
    }

    try {
      upsertHealthDailySummary(app.db, {
        userId: request.userId,
        date: body.date,
        timezone: body.timezone,
        partial: body.partial,
        source: body.source,
        metrics: body.metrics!,
      })
    } catch (error) {
      if (error instanceof DayFinalizedError) {
        return reply.code(409).send({ error: 'day_finalized' })
      }
      throw error
    }

    return reply.code(204).send()
  })

  app.get('/data/health/daily-summaries/latest', { preHandler: app.authenticate }, async (request, reply) => {
    const summary = getLatestHealthDailySummary(app.db, request.userId)
    if (!summary) {
      return reply.code(404).send({ error: 'not_found' })
    }

    return serializeHealthDailySummary(summary)
  })

  app.get('/data/health/daily-summaries', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { limit?: string; before?: string; after?: string }
    const limit = parsePageLimit(query.limit)
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const anchors = parseListAnchors(query)
    if (anchors === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const page = listHealthDailySummariesPage(app.db, request.userId, limit, anchors)
    if (!page) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const firstId = page.summaries[0]?.id
    const lastId = page.summaries[page.summaries.length - 1]?.id

    return {
      summaries: page.summaries.map(serializeHealthDailySummary),
      _links: buildHalLinks({
        basePath: '/data/health/daily-summaries',
        limit,
        before: anchors.before,
        after: anchors.after,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        firstId,
        lastId,
      }),
    }
  })
}

export default dataHealthRoutes

function serializeHealthDailySummary(row: HealthDailySummaryRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    date: row.date,
    timezone: row.timezone,
    partial: row.partial === 1,
    finalized_at: row.finalized_at,
    synced_at: row.synced_at,
    source: row.source,
    metrics: parseStoredHealthMetrics(row.metrics_json),
  }
}

function describeUpsertBodyFailure(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return ['body: expected object']
  }

  const candidate = value as Partial<UpsertHealthDailySummaryBody>
  const reasons: string[] = []

  if (!parseHealthDate(candidate.date)) {
    reasons.push(`date: invalid '${String(candidate.date)}'`)
  }
  if (typeof candidate.timezone !== 'string' || candidate.timezone.trim().length === 0) {
    reasons.push('timezone: missing or empty')
  }
  if (typeof candidate.partial !== 'boolean') {
    reasons.push(`partial: expected boolean, got ${typeof candidate.partial}`)
  }
  if (typeof candidate.source !== 'string' || !VALID_SOURCES.has(candidate.source)) {
    reasons.push(`source: invalid '${String(candidate.source)}'`)
  }

  reasons.push(...describeHealthMetricsValidationFailure(candidate.metrics))
  return reasons
}

function parseUpsertBody(value: unknown): UpsertHealthDailySummaryBody | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const candidate = value as Partial<UpsertHealthDailySummaryBody>
  const date = parseHealthDate(candidate.date)
  const metrics = validateHealthMetrics(candidate.metrics)

  if (
    !date ||
    typeof candidate.timezone !== 'string' ||
    candidate.timezone.trim().length === 0 ||
    typeof candidate.partial !== 'boolean' ||
    typeof candidate.source !== 'string' ||
    !VALID_SOURCES.has(candidate.source) ||
    !metrics
  ) {
    return null
  }

  return {
    date,
    timezone: candidate.timezone.trim(),
    partial: candidate.partial,
    source: candidate.source,
    metrics,
  }
}