import type { FastifyPluginAsync } from 'fastify'
import {
  getDeviceSyncCursor,
  isDeviceRegistered,
  setDeviceSyncCursor,
} from '../db/repos/device-sync-state.js'
import { isValidAnchor } from '../lib/pagination.js'
import { buildInbox, isValidDeviceId } from '../lib/sync-inbox.js'

const syncInboxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/sync/inbox', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { device_id?: string; since?: string }
    if (!isValidDeviceId(query.device_id)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    if (!isDeviceRegistered(app.db, request.userId, query.device_id!)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    if (query.since !== undefined && !isValidAnchor(query.since)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const storedCursor = getDeviceSyncCursor(app.db, request.userId, query.device_id!)
    const since = query.since !== undefined ? query.since : storedCursor

    const result = buildInbox(app.db, request.userId, since, {
      maxGap: app.syncInboxMaxGap,
    })

    setDeviceSyncCursor(app.db, request.userId, query.device_id!, result.next_cursor)

    return result
  })
}

export default syncInboxRoutes