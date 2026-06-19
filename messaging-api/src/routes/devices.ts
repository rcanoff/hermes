import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ensureDeviceRegistered } from '../db/repos/device-sync-state.js'

const registerSchema = z.object({
  device_id: z.string().uuid(),
})

const devicesRoutes: FastifyPluginAsync = async (app) => {
  app.put('/devices/me', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    ensureDeviceRegistered(app.db, request.userId, parsed.data.device_id)
    return { ok: true as const }
  })
}

export default devicesRoutes