import type { FastifyPluginAsync } from 'fastify'
import { getConversationForUser } from '../db/repos/conversations.js'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { getProcessByAssistantMessageIds } from '../db/repos/process.js'
import { createRun, getActiveRun } from '../db/repos/runs.js'
import { applyMessageEdit, MessageEditError } from '../services/message-editor.js'
import { executeAssistantRun } from '../services/run-executor.js'
import { generateAndSaveTitle } from '../services/title-generator.js'
import type { StreamEvent } from '../streams/hub.js'

interface MessageBody {
  text?: string
  content?: string
}

const messageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const rows = listMessages(app.db, conversation.id)
    const assistantIds = rows.filter((message) => message.role === 'assistant').map((message) => message.id)
    const processMap = getProcessByAssistantMessageIds(app.db, assistantIds)

    return rows.map((message) => {
      if (message.role !== 'assistant') {
        return message
      }

      const process = processMap.get(message.id)
      return process ? { ...message, process } : message
    })
  })

  app.post('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (!isMessageBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const content = extractMessageText(request.body)
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
        const messages = listMessages(app.db, conversation.id)
        const message = messages.find((entry) => entry.id === messageId)

        if (!message) {
          throw new Error('message_not_found')
        }

        return {
          message,
          runId,
          shouldGenerateTitle: conversation.title === null && messages.length === 1,
        }
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

      if (created.shouldGenerateTitle) {
        void generateAndSaveTitle({
          db: app.db,
          hermesClient: app.hermesClient,
          hub: app.streamHub,
          conversationId: conversation.id,
          userMessageText: content,
        }).catch((error) => {
          app.log.warn({ err: error, conversationId: conversation.id }, 'title generation failed')
        })
      }

      return reply.code(202).send({ message: created.message })
    } catch (error) {
      if (error instanceof Error && error.message === 'run_conflict') {
        return reply.code(409).send({ error: 'run_conflict' })
      }

      throw error
    }
  })

  app.patch('/conversations/:id/messages/:messageId', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (getActiveRun(app.db, conversation.id)) {
      return reply.code(409).send({ error: 'run_conflict' })
    }

    if (!isMessageBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const content = extractMessageText(request.body)
    if (!content) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const messageId = (request.params as { messageId: string }).messageId

    try {
      const edited = applyMessageEdit(app.db, conversation.id, messageId, content)

      void executeAssistantRun({
        db: app.db,
        hermesClient: app.hermesClient,
        hub: app.streamHub,
        conversationId: conversation.id,
        hermesSessionId: edited.hermesSessionId,
        userMessageId: edited.message.id,
        runId: edited.runId,
        rewindMessageIds: [edited.removedAssistantMessageId],
      }).catch((error) => {
        app.log.error({ err: error, conversationId: conversation.id }, 'assistant rerun after edit failed')
      })

      return reply.code(202).send({ message: edited.message })
    } catch (error) {
      if (error instanceof MessageEditError) {
        if (error.code === 'not_found') {
          return reply.code(404).send({ error: 'not_found' })
        }

        return reply.code(400).send({ error: 'edit_not_allowed' })
      }

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

function isMessageBody(value: unknown): value is MessageBody {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const body = value as MessageBody
  return typeof body.text === 'string' || typeof body.content === 'string'
}

function extractMessageText(body: MessageBody): string {
  const raw = typeof body.text === 'string' ? body.text : body.content
  return typeof raw === 'string' ? raw.trim() : ''
}
