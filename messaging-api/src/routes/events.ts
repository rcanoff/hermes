import type { FastifyPluginAsync } from 'fastify'

const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events/stream', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.sessionId) {
      return reply.code(401).send({ error: 'session_required' })
    }

    const sessionId = request.sessionId
    const userId = request.userId
    app.streamHub.registerUserSession(userId, sessionId)
    request.log.info(
      {
        userId,
        sessionId,
        registeredSessions: app.streamHub.countUserSessions(userId),
        connectedSessions: app.streamHub.countUserSessionsWithListeners(userId),
      },
      'SSE session stream connected',
    )

    reply.sseInit()

    let closed = false
    const pingInterval = setInterval(() => {
      if (!closed && !reply.raw.writableEnded) {
        reply.raw.write(': ping\n\n')
      }
    }, 30_000)

    const unsubscribe = app.streamHub.replaceSessionConnection(sessionId, (event) => {
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
      app.streamHub.unregisterUserSession(sessionId)
      request.log.info({ userId, sessionId }, 'SSE session stream disconnected')
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