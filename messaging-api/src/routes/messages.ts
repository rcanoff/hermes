import type { FastifyPluginAsync } from 'fastify'
import { getConversationForUser } from '../db/repos/conversations.js'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { createRun, getActiveRun } from '../db/repos/runs.js'
import { executeAssistantRun } from '../services/run-executor.js'
import type { StreamEvent } from '../streams/hub.js'

interface MessageBody {
  content?: string
}

const messageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    return listMessages(app.db, conversation.id)
  })

  app.post('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (!isMessageBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const content = request.body.content.trim()
    if (!content) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    try {
      const created = app.db.transaction(() => {
        const messageId = insertMessage(app.db, {
          conversationId: conversation.id,
          role: 'user',
          content,
        })
        const runId = createRun(app.db, conversation.id, messageId)
        const message = listMessages(app.db, conversation.id).find((entry) => entry.id === messageId)

        if (!message) {
          throw new Error('message_not_found')
        }

        return { message, runId }
      })()

      void executeAssistantRun({
        db: app.db,
        hermesClient: app.hermesClient,
        hub: app.streamHub,
        conversationId: conversation.id,
        hermesSessionId: conversation.hermes_session_id,
        userMessageId: created.message.id,
        runId: created.runId,
      }).catch((error) => {
        app.log.error({ err: error, conversationId: conversation.id }, 'assistant run failed')
      })

      return reply.code(202).send({ message: created.message })
    } catch (error) {
      if (error instanceof Error && error.message === 'run_conflict') {
        return reply.code(409).send({ error: 'run_conflict' })
      }

      throw error
    }
  })

  app.get('/conversations/:id/stream', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const activeRun = getActiveRun(app.db, conversation.id)
    if (!activeRun) {
      return reply.code(409).send({ error: 'no_active_run' })
    }

    reply.sseInit()

    const unsubscribe = app.streamHub.subscribe(conversation.id, (event) => {
      reply.sseSend(event.event, event.data)

      if (event.event === 'done' || event.event === 'error') {
        unsubscribe()
        reply.sseEnd()
      }
    })

    request.raw.on('close', () => {
      unsubscribe()
      reply.sseEnd()
    })
  })
}

export default messageRoutes

function getOwnedConversation(
  app: Parameters<FastifyPluginAsync>[0],
  userId: string,
  conversationId: string,
) {
  return getConversationForUser(app.db, userId, conversationId)
}

function isMessageBody(value: unknown): value is Required<MessageBody> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MessageBody).content === 'string'
  )
}
