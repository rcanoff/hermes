import type { FastifyPluginAsync } from 'fastify'
import {
  getLatestLocationEvent,
  insertLocationEvent,
  listLocationEvents,
  type LocationEventRow,
} from '../db/repos/location-events.js'

const VALID_TRIGGERS = new Set(['manual', 'significant_change', 'interval'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface LocationEventBody {
  lat: number
  lon: number
  accuracy_m: number
  timestamp: string
  trigger: string
  source: string
  address?: string
}

const dataLocationRoutes: FastifyPluginAsync = async (app) => {
  app.post('/data/location/events', { preHandler: app.authenticate }, async (request, reply) => {
    if (!isLocationEventBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const body = request.body
    const event = insertLocationEvent(app.db, {
      userId: request.userId,
      lat: body.lat,
      lon: body.lon,
      accuracyM: body.accuracy_m,
      timestamp: body.timestamp,
      trigger: body.trigger,
      source: body.source,
      address: body.address,
    })

    if (event.address_status === 'pending') {
      app.addressEnrichmentQueue.enqueue(event.id)
    }

    return reply.code(204).send()
  })

  app.get('/data/location/latest', { preHandler: app.authenticate }, async (request, reply) => {
    const event = getLatestLocationEvent(app.db, request.userId)
    if (!event) {
      return reply.code(404).send({ error: 'not_found' })
    }

    return serializeLocationEvent(event)
  })

  app.get('/data/location/events', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { limit?: string; before?: string }
    const limit = parseLimit(query.limit)
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    if (query.before !== undefined && !UUID_PATTERN.test(query.before)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const events = listLocationEvents(app.db, request.userId, limit, query.before)
    return { events: events.map(serializeLocationEvent) }
  })
}

export default dataLocationRoutes

function serializeLocationEvent(row: LocationEventRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    lat: row.lat,
    lon: row.lon,
    accuracy_m: row.accuracy_m,
    timestamp: row.timestamp,
    trigger: row.trigger,
    source: row.source,
    address: row.address,
    address_source: row.address_source,
    address_status: row.address_status,
    created_at: row.created_at,
  }
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return 20
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    return null
  }

  return parsed
}

function isLocationEventBody(value: unknown): value is LocationEventBody {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<LocationEventBody>
  const hasValidAddress =
    candidate.address === undefined ||
    (typeof candidate.address === 'string' && candidate.address.length > 0)

  return (
    isLatitude(candidate.lat) &&
    isLongitude(candidate.lon) &&
    isAccuracyMeters(candidate.accuracy_m) &&
    isIsoTimestamp(candidate.timestamp) &&
    typeof candidate.trigger === 'string' &&
    VALID_TRIGGERS.has(candidate.trigger) &&
    typeof candidate.source === 'string' &&
    hasValidAddress
  )
}

function isLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90
}

function isLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180
}

function isAccuracyMeters(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }

  const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  if (!isoUtcPattern.test(value)) {
    return false
  }

  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}