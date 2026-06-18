import type { FastifyPluginAsync } from 'fastify'
import { getConversationForUser, setBootstrapPrompt } from '../db/repos/conversations.js'
import { insertMessage, listMessages, listMessagesPage } from '../db/repos/messages.js'
import { validateBootstrap } from '../lib/bootstrap.js'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'
import { getProcessByAssistantMessageIds } from '../db/repos/process.js'
import { createRun, getActiveRun } from '../db/repos/runs.js'
import { applyMessageEdit, MessageEditError } from '../services/message-editor.js'
import { executeAssistantRun } from '../services/run-executor.js'
import { generateAndSaveTitle } from '../services/title-generator.js'
import { emitConversationMessageUpsert } from '../services/chat-sync-emitter.js'
import type { StreamEvent } from '../streams/hub.js'

interface MessageBody {
  text?: string
  content?: string
  bootstrap?: string
}

class BootstrapValidationError extends Error {
  constructor() {
    super('bootstrap_validation_failed')
  }
}

const messageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const query = request.query as { limit?: string; before?: string; after?: string }
    const limit = parsePageLimit(query.limit)
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const anchors = parseListAnchors(query)
    if (anchors === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const page = listMessagesPage(app.db, conversation.id, limit, anchors)
    if (!page) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const assistantIds = page.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.id)
    const processMap = getProcessByAssistantMessageIds(app.db, assistantIds)

    const messages = page.messages.map((message) => {
      if (message.role !== 'assistant') {
        return message
      }

      const process = processMap.get(message.id)
      return process ? { ...message, process } : message
    })

    const firstId = page.messages[0]?.id
    const lastId = page.messages[page.messages.length - 1]?.id

    return {
      messages,
      _links: buildHalLinks({
        basePath: `/conversations/${conversation.id}/messages`,
        limit,
        before: anchors.before,
        after: anchors.after,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        firstId,
        lastId,
        linkStyle: 'chronological-tail',
      }),
    }
  })

  app.post('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (!isMessageBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const body = request.body
    const content = extractMessageText(body)
    if (!content) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    try {
      let bootstrapPrompt = conversation.bootstrap_prompt

      const created = app.db.transaction(() => {
        const existingMessages = listMessages(app.db, conversation.id)
        const isFirstMessage = existingMessages.length === 0

        if (isFirstMessage && body.bootstrap !== undefined) {
          const bootstrap = validateBootstrap(body.bootstrap)
          if (!bootstrap) {
            throw new BootstrapValidationError()
          }
          setBootstrapPrompt(app.db, conversation.id, bootstrap)
          bootstrapPrompt = bootstrap
        }

        const messageId = insertMessage(app.db, {
          conversationId: conversation.id,
          role: 'user',
          content,
        })
        const originSessionId = request.sessionId ?? 'legacy'
        const runId = createRun(app.db, conversation.id, messageId, originSessionId)
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

      emitConversationMessageUpsert(
        app.db,
        request.userId,
        conversation.id,
        created.message,
      )

      void executeAssistantRun({
        db: app.db,
        hermesClient: app.hermesClient,
        hub: app.streamHub,
        conversationId: conversation.id,
        hermesSessionId: conversation.hermes_session_id,
        userMessageId: created.message.id,
        userId: request.userId,
        companionUsername: request.username,
        bootstrapPrompt,
        runId: created.runId,
        originSessionId: request.sessionId,
      }).catch((error) => {
        app.log.error({ err: error, conversationId: conversation.id }, 'assistant run failed')
      })

      if (created.shouldGenerateTitle) {
        void generateAndSaveTitle({
          db: app.db,
          hermesClient: app.hermesClient,
          hub: app.streamHub,
          conversationId: conversation.id,
          userId: request.userId,
          userMessageText: content,
          originSessionId: request.sessionId,
        }).catch((error) => {
          app.log.warn({ err: error, conversationId: conversation.id }, 'title generation failed')
        })
      }

      return reply.code(202).send({ message: created.message })
    } catch (error) {
      if (error instanceof BootstrapValidationError) {
        return reply.code(400).send({ error: 'invalid_request' })
      }

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
      const originSessionId = request.sessionId ?? 'legacy'
      const edited = applyMessageEdit(
        app.db,
        request.userId,
        conversation.id,
        messageId,
        content,
        originSessionId,
      )

      void executeAssistantRun({
        db: app.db,
        hermesClient: app.hermesClient,
        hub: app.streamHub,
        conversationId: conversation.id,
        hermesSessionId: edited.hermesSessionId,
        userMessageId: edited.message.id,
        userId: request.userId,
        companionUsername: request.username,
        bootstrapPrompt: conversation.bootstrap_prompt,
        runId: edited.runId,
        rewindMessageIds: [edited.removedAssistantMessageId],
        originSessionId: request.sessionId,
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

    reply.sseInit()

    let closed = false
    let waitTimeout: NodeJS.Timeout | undefined

    const closeStream = () => {
      if (closed) {
        return
      }

      closed = true
      if (waitTimeout) {
        clearTimeout(waitTimeout)
        waitTimeout = undefined
      }
      unsubscribe()
      reply.sseEnd()
    }

    const unsubscribe = app.streamHub.subscribeLegacy(conversation.id, (event) => {
      if (waitTimeout) {
        clearTimeout(waitTimeout)
        waitTimeout = undefined
      }

      reply.sseSend(event.event, event.data)

      if (event.event === 'done' || event.event === 'error') {
        closeStream()
      }
    })

    if (!getActiveRun(app.db, conversation.id)) {
      waitTimeout = setTimeout(() => {
        if (!closed) {
          reply.sseSend('error', { code: 'no_active_run' })
          closeStream()
        }
      }, app.streamWaitMs)
    }

    request.raw.on('close', () => {
      closeStream()
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
