import type { FastifyPluginAsync } from 'fastify'
import { getConversationForUser } from '../db/repos/conversations.js'
import {
  deleteConversationLocation,
  getConversationLocation,
  upsertConversationLocation,
} from '../db/repos/locations.js'

interface LocationBody {
  lat: number
  lon: number
  accuracy_m: number
  timestamp: string
  mode: string
  source: string
}

const locationRoutes: FastifyPluginAsync = async (app) => {
  app.post('/conversations/:id/location', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    if (!getConversationForUser(app.db, request.userId, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (!isLocationBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    upsertConversationLocation(app.db, {
      conversationId,
      lat: request.body.lat,
      lon: request.body.lon,
      accuracyM: request.body.accuracy_m,
      timestamp: request.body.timestamp,
      mode: request.body.mode,
      source: request.body.source,
    })

    return reply.code(204).send()
  })

  app.get('/conversations/:id/location/latest', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    if (!getConversationForUser(app.db, request.userId, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const location = getConversationLocation(app.db, conversationId)
    if (!location) {
      return reply.code(404).send({ error: 'not_found' })
    }

    return location
  })

  app.delete('/conversations/:id/location', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    if (!getConversationForUser(app.db, request.userId, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    deleteConversationLocation(app.db, conversationId)
    return reply.code(204).send()
  })
}

export default locationRoutes

function isLocationBody(value: unknown): value is LocationBody {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<LocationBody>
  return (
    isLatitude(candidate.lat) &&
    isLongitude(candidate.lon) &&
    isAccuracyMeters(candidate.accuracy_m) &&
    isIsoTimestamp(candidate.timestamp) &&
    typeof candidate.mode === 'string' &&
    typeof candidate.source === 'string'
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
