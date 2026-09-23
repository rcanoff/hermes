import type { FastifyPluginAsync } from 'fastify'
import { getConversationForUser, setBootstrapPrompt } from '../db/repos/conversations.js'
import {
  findMessageByClientId,
  findRecentDuplicateUserMessage,
  insertMessage,
  getMessage,
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
import { removeAttachmentTree } from '../lib/attachment-storage.js'
import { validateBootstrap } from '../lib/bootstrap.js'
import { resolveJobConversationBootstrap } from '../lib/job-conversation.js'
import { buildConversationSyncEntry } from '../lib/conversation-sync-entry.js'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'
import { getProcessByAssistantMessageIds } from '../db/repos/process.js'
import { createRun, getActiveRun } from '../db/repos/runs.js'
import { applyMessageEdit, MessageEditError } from '../services/message-editor.js'
import {
  listMessagesFromAnchor,
  MessageRewindError,
  removeConversationMessagesFrom,
} from '../services/conversation-message-rewind.js'
import { GrokInputError, resolveGrokInput } from '../services/grok-input.js'
import { enqueueGroupRun } from '../db/repos/group-bot-runs.js'
import {
  appendGroupAssistantMessage,
  drainGroupRuns,
  groupPromptForMention,
  type GroupRunDeps,
} from '../services/group-run.js'
import { executeAssistantRun } from '../services/run-executor.js'
import { scheduleTitleGeneration } from '../services/title-generator.js'
import { scheduleConversationSessionWarmup } from '../services/session-warmup.js'
import {
  appendAccountMessageUpsert,
  appendConversationMessageUpsert,
} from '../db/repos/chat-sync-events.js'
import {
  emitAccountConversationUpsert,
  emitConversationMessageUpsert,
  emitToConversationMembers,
} from '../services/chat-sync-emitter.js'
import {
  publishAccountConversationUpsert,
  publishMessageUpsert,
  publishMessagesRewound,
  publishToConversationMembers,
  publishTypingToOtherMembers,
} from '../streams/sse-mutation-publisher.js'
import type { StreamEvent } from '../streams/hub.js'
import { typingPostBodySchema } from '../streams/typing-event.js'

interface MessageBody {
  text?: string
  content?: string
  bootstrap?: string
  attachment_ids?: string[]
  client_message_id?: string | null
  mentioned_bot_id?: string | null
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
    const messages = enrichMessagesWithAttachments(app.db, page.messages, attachmentMap).map((message) => {
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

    const shared = conversation.kind === 'user_dm' || conversation.kind === 'group'
    const clientMessageId = optionalBodyId(body, 'client_message_id')
    const mentionedBotId = optionalBodyId(body, 'mentioned_bot_id')
    if (shared && !isUuid(clientMessageId)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    if (clientMessageId && isUuid(clientMessageId)) {
      const existing = findMessageByClientId(
        app.db,
        conversation.id,
        request.userId,
        clientMessageId,
      )
      if (existing) {
        return reply.code(200).send({ message: enrichMessageWithAttachments(app.db, existing) })
      }
    }
    if (
      mentionedBotId !== undefined &&
      (conversation.kind !== 'group' || mentionedBotId !== conversation.bot_id)
    ) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    if (attachmentIds.length === 0 && !clientMessageId) {
      const duplicate = findRecentDuplicateUserMessage(app.db, conversation.id, content)
      if (duplicate) {
        return reply.code(202).send({ message: enrichMessageWithAttachments(app.db, duplicate) })
      }
    }

    try {
      if (shared) {
        const created = app.db.transaction(() => {
          const mention = mentionedBotId
            ? groupPromptForMention(app.db, {
                conversationId: conversation.id,
                botId: mentionedBotId,
                username: request.username,
                text: content,
              })
            : null
          const messageId = insertMessage(app.db, {
            conversationId: conversation.id,
            role: 'user',
            content,
            senderUserId: request.userId,
            clientMessageId,
            mentionedBotId: mentionedBotId ?? null,
          })
          if (attachmentIds.length > 0) {
            const staged = validateStagedAttachments(app.db, request.userId, attachmentIds)
            if (!staged) {
              throw new Error('invalid_attachments')
            }
            linkAttachmentsToMessage(app.db, request.userId, messageId, attachmentIds)
          }
          const stored = getMessage(app.db, conversation.id, messageId)
          if (!stored) {
            throw new Error('message_not_found')
          }
          const enriched = enrichMessageWithAttachments(app.db, stored)
          emitToConversationMembers(app.db, conversation.id, (userId) => {
            appendAccountMessageUpsert(app.db, userId, conversation.id, enriched)
            emitAccountConversationUpsert(app.db, userId, conversation.id, app.companionModels)
          })
          appendConversationMessageUpsert(app.db, conversation.user_id, conversation.id, enriched)
          const runError =
            mention && !mention.fits
              ? appendGroupAssistantMessage(app.db, conversation, 'context_too_large', app.companionModels)
              : null
          if (mention?.fits) {
            enqueueGroupRun(app.db, { messageId, conversationId: conversation.id })
          }
          return { message: enriched, runError, enqueued: mention?.fits === true }
        })()

        publishToConversationMembers(app.streamHub, app.db, conversation.id, {
          event: 'message_upsert',
          data: { conversationId: conversation.id, message: created.message },
        })
        if (created.runError) {
          publishToConversationMembers(app.streamHub, app.db, conversation.id, {
            event: 'message_upsert',
            data: { conversationId: conversation.id, message: created.runError },
          })
        }
        const row = getConversationForUser(app.db, request.userId, conversation.id)
        if (row) {
          publishToConversationMembers(app.streamHub, app.db, conversation.id, {
            event: 'conversation_upsert',
            data: { conversation: buildConversationSyncEntry(app.db, row, app.companionModels) },
          })
        }
        if (created.enqueued) {
          void drainGroupRuns(groupRunDeps(app)).catch((error) => {
            app.log.error({ err: error }, 'group run drain failed')
          })
        }
        return reply.code(202).send({ message: created.message })
      }

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
      publishMessageUpsert(
        app.streamHub,
        request.userId,
        conversation.id,
        enrichedMessage,
      )
      publishAccountConversationUpsert(
        app.streamHub,
        app.db,
        request.userId,
        conversation.id,
        app.companionModels,
      )

      if (created.shouldGenerateTitle && content) {
        scheduleTitleGeneration({
          db: app.db,
          hermesClient: app.hermesClient,
          hub: app.streamHub,
          conversationId: conversation.id,
          userId: request.userId,
          userMessageText: content,
          originSessionId: request.sessionId ?? 'legacy',
          titleGeneration: app.titleGeneration,
          log: (message, meta) => {
            app.log.info(meta ?? {}, message)
          },
        })
      }

      void executeAssistantRun({
        db: app.db,
        hermesClient: app.hermesClient,
        grokGatewayClient: app.grokGatewayClient,
        hermesHome: app.hermesHome,
        hub: app.streamHub,
        abortRegistry: app.runAbortRegistry,
        conversationId: conversation.id,
        hermesSessionId: conversation.hermes_session_id,
        userMessageId: created.message.id,
        userId: request.userId,
        companionUsername: request.username,
        bootstrapPrompt,
        runId: created.runId,
        originSessionId: request.sessionId,
        cronPromptSynthesisLlm: app.cronPromptSynthesis,
        companionModels: app.companionModels,
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

  app.post('/conversations/:id/run/interrupt', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }
    if (isSharedKind(conversation.kind)) {
      return reply.code(409).send({ error: 'unavailable' })
    }
    app.runAbortRegistry.abort(conversation.id, 'interrupt')
    try {
      await app.grokGatewayClient.cancelPrompt(conversation.id)
    } catch (error) {
      app.log.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          conversationId: conversation.id,
        },
        'failed to cancel grok gateway prompt',
      )
    }
    return reply.code(204).send()
  })

  app.patch('/conversations/:id/messages/:messageId', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation) {
      return reply.code(404).send({ error: 'not_found' })
    }
    if (isSharedKind(conversation.kind)) {
      return reply.code(409).send({ error: 'delete_unavailable' })
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
        grokGatewayClient: app.grokGatewayClient,
        hermesHome: app.hermesHome,
        hub: app.streamHub,
        abortRegistry: app.runAbortRegistry,
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
      if (isSharedKind(conversation.kind)) {
        return reply.code(409).send({ error: 'delete_unavailable' })
      }

      if (getActiveRun(app.db, conversation.id)) {
        return reply.code(409).send({ error: 'run_conflict' })
      }

      const messageId = (request.params as { messageId: string }).messageId

      try {
        const toRemove = listMessagesFromAnchor(app.db, conversation.id, messageId)
        const attachmentMap = listAttachmentsForMessages(
          app.db,
          toRemove.map((message) => message.id),
        )
        for (const rows of attachmentMap.values()) {
          for (const row of rows) {
            removeAttachmentTree(app.attachmentsDir, request.userId, row.id)
          }
        }

        const removed = removeConversationMessagesFrom(
          app.db,
          request.userId,
          conversation.id,
          messageId,
        )
        publishMessagesRewound(
          app.streamHub,
          request.userId,
          conversation.id,
          removed.removedMessageIds,
          removed.hermesSessionId,
        )
        app.log.info(
          {
            userId: request.userId,
            sessionId: request.sessionId,
            conversationId: conversation.id,
            removedCount: removed.removedMessageIds.length,
            registeredSessions: app.streamHub.countUserSessions(request.userId),
            connectedSessions: app.streamHub.countUserSessionsWithListeners(request.userId),
          },
          'messages_rewound published to user sessions',
        )

        const refreshed = getConversationForUser(app.db, request.userId, conversation.id)
        if (refreshed) {
          scheduleConversationSessionWarmup({
            hermesClient: app.hermesClient,
            conversation: refreshed,
            db: app.db,
            hermesHome: app.hermesHome,
            companionUserId: request.userId,
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

  app.post(
    '/conversations/:id/messages/:messageId/input',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, messageId } = request.params as { id: string; messageId: string }
      const conversation = getOwnedConversation(app, request.userId, id)
      if (!conversation) {
        return reply.code(404).send({ error: 'not_found' })
      }
      if (isSharedKind(conversation.kind)) {
        return reply.code(409).send({ error: 'unavailable' })
      }

      const body = parseInputBody(request.body)
      if (!body) {
        return reply.code(400).send({ error: 'invalid_request' })
      }

      try {
        await resolveGrokInput({
          db: app.db,
          hub: app.streamHub,
          grokGatewayClient: app.grokGatewayClient,
          userId: request.userId,
          conversationId: conversation.id,
          messageId,
          action: body.action,
          text: body.text,
          companionModels: app.companionModels,
        })
        return reply.code(204).send()
      } catch (error) {
        if (error instanceof GrokInputError) {
          if (error.code === 'not_found') {
            return reply.code(404).send({ error: 'not_found' })
          }
          if (error.code === 'grok_unavailable') {
            return reply.code(503).send({ error: 'grok_unavailable' })
          }
          if (error.code === 'invalid_request') {
            return reply.code(400).send({ error: 'invalid_request' })
          }
          return reply.code(409).send({ error: error.code })
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

  app.post('/conversations/:id/typing', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getOwnedConversation(app, request.userId, (request.params as { id: string }).id)
    if (!conversation || !isSharedKind(conversation.kind)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    const parsed = typingPostBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    publishTypingToOtherMembers(
      app.streamHub,
      app.db,
      conversation.id,
      request.userId,
      parsed.data.active,
    )
    return reply.code(204).send()
  })
}

export default messageRoutes

function groupRunDeps(app: Parameters<FastifyPluginAsync>[0]): GroupRunDeps {
  return {
    db: app.db,
    hub: app.streamHub,
    hermesClient: app.hermesClient,
    bridgeUrl: app.titleGeneration.bridgeUrl,
    bridgeApiKey: app.titleGeneration.bridgeApiKey,
    timeoutMs: app.titleGeneration.timeoutMs,
    catalog: app.companionModels,
    log: (message, meta) => {
      app.log.error(meta ?? {}, message)
    },
  }
}

function isSharedKind(kind: string): boolean {
  return kind === 'user_dm' || kind === 'group'
}

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function optionalBodyId(
  body: MessageBody,
  key: 'client_message_id' | 'mentioned_bot_id',
): string | undefined {
  if (body[key] == null) {
    return undefined
  }
  return typeof body[key] === 'string' ? body[key] : ''
}

function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function parseInputBody(value: unknown): { action: string; text?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const body = value as { action?: unknown; text?: unknown }
  if (typeof body.action !== 'string' || !body.action.trim()) {
    return null
  }
  if (body.text !== undefined && typeof body.text !== 'string') {
    return null
  }
  return { action: body.action.trim(), text: typeof body.text === 'string' ? body.text : undefined }
}
