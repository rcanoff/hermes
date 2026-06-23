import type { FastifyPluginAsync } from 'fastify'

const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events/stream', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.sessionId) {
      return reply.code(401).send({ error: 'session_required' })
    }

    const userId = request.userId
    app.streamHub.registerUserSession(userId, request.sessionId)

    reply.sseInit()

    let closed = false
    const pingInterval = setInterval(() => {
      if (!closed && !reply.raw.writableEnded) {
        reply.raw.write(': ping\n\n')
      }
    }, 30_000)

    const unsubscribe = app.streamHub.replaceSessionConnection(request.sessionId, (event) => {
      if (!closed) {
        reply.sseSend(event.event, event.data)
      }
    })

    const closeStream = () => {
      if (closed) {
        return
      }
      closed = true
      clearInterval(pingInterval)
      app.streamHub.unregisterUserSession(request.sessionId)
      unsubscribe()
      reply.sseEnd()
    }

    await new Promise<void>((resolve) => {
      request.raw.on('close', () => {
        closeStream()
        resolve()
      })
    })
  })
}

export default eventsRoutes