import type Database from 'better-sqlite3'
import type { FastifyPluginAsync } from 'fastify'
import {
  conversationHasSyncTail,
  listAccountSyncEvents,
  listConversationDeletionSync,
  listConversationSyncEvents,
  type ConversationSyncEvent,
} from '../db/repos/chat-sync-events.js'
import { getConversationForUser } from '../db/repos/conversations.js'
import { getProcessByAssistantMessageIds } from '../db/repos/process.js'
import { buildConversationMessageSyncSnapshot } from '../lib/conversation-sync-entry.js'
import { SYNC_MARKER_ORIGIN } from '../lib/sync-marker.js'

const DEFAULT_ACCOUNT_SYNC_LIMIT = 100
const MAX_ACCOUNT_SYNC_LIMIT = 500
const DEFAULT_CONVERSATION_SYNC_LIMIT = 200
const MAX_CONVERSATION_SYNC_LIMIT = 1000

const chatSyncRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations/sync', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { since?: string; limit?: string }
    const limit = parseSyncLimit(query.limit, DEFAULT_ACCOUNT_SYNC_LIMIT, MAX_ACCOUNT_SYNC_LIMIT)
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const page = listAccountSyncEvents(app.db, request.userId, query.since, limit)
    if (page === null) {
      return query.since
        ? reply.code(400).send({ error: 'sync_marker_invalid' })
        : reply.code(400).send({ error: 'invalid_request' })
    }

    return page
  })

  app.get('/conversations/:id/sync', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    const query = request.query as { since?: string; limit?: string }
    const limit = parseSyncLimit(
      query.limit,
      DEFAULT_CONVERSATION_SYNC_LIMIT,
      MAX_CONVERSATION_SYNC_LIMIT,
    )
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const existing = getConversationForUser(app.db, request.userId, conversationId)
    if (existing) {
      const page = listConversationSyncEvents(
        app.db,
        request.userId,
        conversationId,
        query.since,
        limit,
      )
      if (page === null) {
        return query.since
          ? reply.code(400).send({ error: 'sync_marker_invalid' })
          : reply.code(400).send({ error: 'invalid_request' })
      }

      return {
        conversation: buildConversationMessageSyncSnapshot(existing),
        events: attachProcessToMessageUpserts(app.db, page.events),
        next_sync_marker: page.next_sync_marker,
        has_more: page.has_more,
      }
    }

    if (!conversationHasSyncTail(app.db, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const deletionPage = listConversationDeletionSync(
      app.db,
      request.userId,
      conversationId,
      query.since,
      limit,
    )
    if (deletionPage === null) {
      return query.since
        ? reply.code(400).send({ error: 'sync_marker_invalid' })
        : reply.code(400).send({ error: 'invalid_request' })
    }

    return {
      conversation: buildDeletedConversationSnapshot(app.db, request.userId, conversationId),
      events: deletionPage.events,
      next_sync_marker: deletionPage.next_sync_marker,
      has_more: deletionPage.has_more,
    }
  })
}

export default chatSyncRoutes

function parseSyncLimit(
  raw: string | undefined,
  defaultLimit: number,
  maxLimit: number,
): number | null {
  if (raw === undefined) {
    return defaultLimit
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) {
    return null
  }

  return parsed
}

function buildDeletedConversationSnapshot(
  db: Database.Database,
  userId: string,
  conversationId: string,
) {
  const row = db
    .prepare(`
      SELECT payload_json
      FROM chat_sync_events
      WHERE scope = 'account'
        AND user_id = ?
        AND conversation_id = ?
        AND event_type = 'conversation_upsert'
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `)
    .get(userId, conversationId) as { payload_json: string } | undefined

  if (row) {
    const payload = JSON.parse(row.payload_json) as {
      conversation: {
        id: string
        hermes_session_id: string
        title: string | null
        created_at: string
        updated_at: string
      }
    }

    return {
      id: payload.conversation.id,
      hermes_session_id: payload.conversation.hermes_session_id,
      title: payload.conversation.title,
      created_at: payload.conversation.created_at,
      updated_at: payload.conversation.updated_at,
    }
  }

  return {
    id: conversationId,
    hermes_session_id: SYNC_MARKER_ORIGIN,
    title: null,
    created_at: '1970-01-01 00:00:00',
    updated_at: '1970-01-01 00:00:00',
  }
}

function attachProcessToMessageUpserts(
  db: Database.Database,
  events: ConversationSyncEvent[],
): ConversationSyncEvent[] {
  const assistantIds = events.flatMap((event) => {
    if (event.type !== 'message_upsert' || event.message.role !== 'assistant') {
      return []
    }

    return [event.message.id]
  })
  const processMap = getProcessByAssistantMessageIds(db, assistantIds)

  return events.map((event) => {
    if (event.type !== 'message_upsert') {
      return event
    }

    if (event.message.role !== 'assistant') {
      return event
    }

    const process = processMap.get(event.message.id)
    if (!process) {
      return event
    }

    return {
      ...event,
      message: {
        ...event.message,
        process,
      },
    }
  })
}