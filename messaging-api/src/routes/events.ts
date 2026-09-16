import type { FastifyPluginAsync } from 'fastify'

const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events/stream', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.sessionId) {
      return reply.code(401).send({ error: 'session_required' })
    }

    const sessionId = request.sessionId
    const userId = request.userId

    reply.sseInit()

    let closed = false
    const pingInterval = setInterval(() => {
      if (!closed && !reply.raw.writableEnded) {
        reply.raw.write(': ping\n\n')
      }
    }, 30_000)

    const closeTransport = () => {
      if (closed) {
        return
      }
      closed = true
      clearInterval(pingInterval)
      request.log.info({ userId, sessionId }, 'SSE session stream disconnected')
      reply.sseEnd()
    }

    const unsubscribe = app.streamHub.connectUserSession(
      userId,
      sessionId,
      (event) => {
        if (!closed) {
          reply.sseSend(event.event, event.data)
        }
      },
      closeTransport,
    )

    request.log.info(
      {
        userId,
        sessionId,
        registeredSessions: app.streamHub.countUserSessions(userId),
        connectedSessions: app.streamHub.countUserSessionsWithListeners(userId),
      },
      'SSE session stream connected',
    )

    const closeStream = () => {
      closeTransport()
      unsubscribe()
    }

    await new Promise<void>((resolve) => {
      const onClose = () => {
        closeStream()
        resolve()
      }
      request.raw.on('close', onClose)
      request.raw.on('error', onClose)
    })
  })
}

export default eventsRoutes