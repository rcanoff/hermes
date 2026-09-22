import type { FastifyPluginAsync } from 'fastify'
import { getConversationById } from '../db/repos/conversations.js'
import type { SessionStreamEvent } from '../streams/hub.js'

const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events/stream', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.sessionId) {
      return reply.code(401).send({ error: 'session_required' })
    }

    const sessionId = request.sessionId
    const userId = request.userId
    const includeShared = (request.query as { include_shared?: string }).include_shared === 'true'

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
        if (!closed && visibleStreamEvent(app.db, event, includeShared)) {
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

function visibleStreamEvent(
  db: Parameters<typeof getConversationById>[0],
  event: SessionStreamEvent,
  includeShared: boolean,
): boolean {
  if (includeShared) {
    return true
  }
  const kind =
    event.event === 'conversation_upsert'
      ? event.data.conversation.kind
      : getConversationById(db, event.data.conversationId)?.kind
  return kind !== 'user_dm' && kind !== 'group'
}

export default eventsRoutes