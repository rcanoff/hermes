import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ensureDeviceRegistered } from '../db/repos/device-sync-state.js'

const registerSchema = z.object({
  device_id: z.string().uuid(),
  ble_public_key: z.string().regex(/^[0-9a-f]{64}$/).optional(),
})

const devicesRoutes: FastifyPluginAsync = async (app) => {
  app.put('/devices/me', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    ensureDeviceRegistered(app.db, request.userId, parsed.data.device_id)
    if (parsed.data.ble_public_key !== undefined) {
      app.db.prepare(`UPDATE users SET ble_public_key = ? WHERE id = ?`).run(
        parsed.data.ble_public_key,
        request.userId,
      )
    }
    return { ok: true as const }
  })
}

export default devicesRoutes