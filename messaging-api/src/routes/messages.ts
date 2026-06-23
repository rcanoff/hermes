import type { FastifyPluginAsync } from 'fastify'
import { getConversationForUser, setBootstrapPrompt } from '../db/repos/conversations.js'
import {
  findRecentDuplicateUserMessage,
  insertMessage,
  listMessages,
  listMessagesPage,
} from '../db/repos/messages.js'
import {
  linkAttachmentsToMessage,
  listAttachmentsForMessages,
  messageHasAttachments,
  validateStagedAttachments,
} from '../db/repos/message-attachments.js'
import {
  enrichMessageWithAttachments,
  enrichMessagesWithAttachments,
} from '../lib/attachment-serializer.js'
import { validateBootstrap } from '../lib/bootstrap.js'
import { resolveJobConversationBootstrap } from '../lib/job-conversation.js'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'
import { getProcessByAssistantMessageIds } from '../db/repos/process.js'
import { createRun, getActiveRun } from '../db/repos/runs.js'
import { applyMessageEdit, MessageEditError } from '../services/message-editor.js'
import {
  MessageRewindError,
  removeConversationMessagesFrom,
} from '../services/conversation-message-rewind.js'
import { executeAssistantRun } from '../services/run-executor.js'
import { scheduleConversationSessionWarmup } from '../services/session-warmup.js'
import { emitConversationMessageUpsert } from '../services/chat-sync-emitter.js'
import type { StreamEvent } from '../streams/hub.js'

interface MessageBody {
  text?: string
  content?: string
  bootstrap?: string
  attachment_ids?: string[]
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

    const attachmentMap = listAttachmentsForMessages(
      app.db,
      page.messages.map((message) => message.id),
    )
    const messages = enrichMessagesWithAttachments(page.messages, attachmentMap).map((message) => {
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

    if (!isCreateMessageBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const body = request.body
    const content = extractMessageText(body)
    const attachmentIds = normalizeAttachmentIds(body.attachment_ids)
    if (!content && attachmentIds.length === 0) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    if (attachmentIds.length > 10) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    if (attachmentIds.length === 0) {
      const duplicate = findRecentDuplicateUserMessage(app.db, conversation.id, content)
      if (duplicate) {
        return reply.code(202).send({ message: enrichMessageWithAttachments(app.db, duplicate) })
      }
    }

    try {
      let bootstrapPrompt = resolveJobConversationBootstrap(conversation, request.username)

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

        if (attachmentIds.length > 0) {
          const staged = validateStagedAttachments(app.db, request.userId, attachmentIds)
          if (!staged) {
            throw new Error('invalid_attachments')
          }
          linkAttachmentsToMessage(app.db, request.userId, messageId, attachmentIds)
        }

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

      const enrichedMessage = enrichMessageWithAttachments(app.db, created.message)
      emitConversationMessageUpsert(
        app.db,
        request.userId,
        conversation.id,
        enrichedMessage,
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
        shouldGenerateTitle: created.shouldGenerateTitle,
        userMessageText: content,
        titleGenerationLlm: app.titleGeneration,
        cronPromptSynthesisLlm: app.cronPromptSynthesis,
        attachmentsDir: app.attachmentsDir,
        visionHistoryMaxBytes: app.visionHistoryMaxBytes,
        cronJobsPath: app.cronJobsPath,
        conversationTitle: conversation.title,
        onAssistantMessageCommitted: async (ctx) => {
          await app.pushNotifications.notifyAssistantMessage({
            userId: request.userId,
            conversationId: conversation.id,
            messageId: ctx.messageId,
            content: ctx.content,
            conversationTitle: conversation.title,
          })
        },
        log: (message, meta) => {
          app.log.info(meta ?? {}, message)
        },
      }).catch((error) => {
        app.log.error({ err: error, conversationId: conversation.id }, 'assistant run failed')
      })

      return reply.code(202).send({ message: enrichedMessage })
    } catch (error) {
      if (error instanceof BootstrapValidationError) {
        return reply.code(400).send({ error: 'invalid_request' })
      }

      if (error instanceof Error && error.message === 'invalid_attachments') {
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

    if (typeof request.body === 'object' && request.body !== null && 'attachment_ids' in request.body) {
      return reply.code(400).send({ error: 'edit_not_allowed' })
    }

    if (!isEditMessageBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const content = extractMessageText(request.body)
    const messageId = (request.params as { messageId: string }).messageId
    const hasPhotos = messageHasAttachments(app.db, messageId)
    if (!content && !hasPhotos) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

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
        bootstrapPrompt: resolveJobConversationBootstrap(conversation, request.username),
        runId: edited.runId,
        rewindMessageIds: [edited.removedAssistantMessageId],
        originSessionId: request.sessionId,
        attachmentsDir: app.attachmentsDir,
        visionHistoryMaxBytes: app.visionHistoryMaxBytes,
        cronJobsPath: app.cronJobsPath,
        conversationTitle: conversation.title,
        onAssistantMessageCommitted: async (ctx) => {
          await app.pushNotifications.notifyAssistantMessage({
            userId: request.userId,
            conversationId: conversation.id,
            messageId: ctx.messageId,
            content: ctx.content,
            conversationTitle: conversation.title,
          })
        },
        log: (message, meta) => {
          app.log.info(meta ?? {}, message)
        },
      }).catch((error) => {
        app.log.error({ err: error, conversationId: conversation.id }, 'assistant rerun after edit failed')
      })

      return reply.code(202).send({ message: enrichMessageWithAttachments(app.db, edited.message) })
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

  app.delete(
    '/conversations/:id/messages/:messageId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const conversation = getOwnedConversation(
        app,
        request.userId,
        (request.params as { id: string }).id,
      )
      if (!conversation) {
        return reply.code(404).send({ error: 'not_found' })
      }

      if (getActiveRun(app.db, conversation.id)) {
        return reply.code(409).send({ error: 'run_conflict' })
      }

      const messageId = (request.params as { messageId: string }).messageId

      try {
        const removed = removeConversationMessagesFrom(
          app.db,
          request.userId,
          conversation.id,
          messageId,
        )

        const refreshed = getConversationForUser(app.db, request.userId, conversation.id)
        if (refreshed) {
          scheduleConversationSessionWarmup({
            hermesClient: app.hermesClient,
            conversation: refreshed,
            companionUsername: request.username,
            log: (message, meta) => {
              app.log.info(meta ?? {}, message)
            },
          })
        }

        return {
          removed_message_ids: removed.removedMessageIds,
          hermes_session_id: removed.hermesSessionId,
        }
      } catch (error) {
        if (error instanceof MessageRewindError) {
          if (error.code === 'not_found') {
            return reply.code(404).send({ error: 'not_found' })
          }

          return reply.code(409).send({ error: 'run_conflict' })
        }

        throw error
      }
    },
  )

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

function isCreateMessageBody(value: unknown): value is MessageBody {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const body = value as MessageBody
  const hasText = typeof body.text === 'string' || typeof body.content === 'string'
  const hasAttachments = Array.isArray(body.attachment_ids)
  return hasText || hasAttachments
}

function isEditMessageBody(value: unknown): value is MessageBody {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const body = value as MessageBody
  return typeof body.text === 'string' || typeof body.content === 'string'
}

function normalizeAttachmentIds(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((id) => typeof id === 'string' && id.length > 0)
}

function extractMessageText(body: MessageBody): string {
  const raw = typeof body.text === 'string' ? body.text : body.content
  return typeof raw === 'string' ? raw.trim() : ''
}
