import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { deletePushDevice, upsertPushDevice } from '../db/repos/push-devices.js'

const deviceTokenSchema = z.string().regex(/^[0-9a-f]{64}$/i)

const registerSchema = z.object({
  device_token: deviceTokenSchema,
  environment: z.enum(['development', 'production']),
})

const deleteSchema = z.object({
  device_token: deviceTokenSchema,
})

const pushRoutes: FastifyPluginAsync = async (app) => {
  app.put('/push/device', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    upsertPushDevice(app.db, {
      userId: request.userId,
      deviceToken: parsed.data.device_token.toLowerCase(),
      environment: parsed.data.environment,
      sessionId: request.sessionId,
    })

    return { ok: true as const }
  })

  app.delete('/push/device', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = deleteSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    deletePushDevice(app.db, parsed.data.device_token.toLowerCase())
    return { ok: true as const }
  })
}

export default pushRoutes