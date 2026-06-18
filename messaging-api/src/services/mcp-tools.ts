import type Database from 'better-sqlite3'
import {
  listPendingInvites,
  listUsers,
  revokeInvite,
  type AccountInviteRow,
} from '../db/repos/account-invites.js'
import { findUserByUsername } from '../db/repos/users.js'
import {
  getHealthDailySummaryByDate,
  getLatestHealthDailySummary,
  listHealthDailySummariesPage,
  parseStoredHealthMetrics,
  type HealthDailySummaryRow,
} from '../db/repos/health-daily-summaries.js'
import {
  getLatestLocationEvent,
  listLocationEventsPage,
  type LocationEventRow,
} from '../db/repos/location-events.js'
import { parseHealthDate, type HealthMetrics } from '../lib/health-metrics.js'
import { buildHalLinks } from '../lib/pagination.js'
import {
  createJobConversation,
  linkJobConversation,
  type ConversationRow,
} from '../db/repos/conversations.js'
import { emitAccountConversationUpsert } from './chat-sync-emitter.js'
import { createInviteRecord } from './invites.js'
import { formatFreshness } from './freshness.js'

export interface UserLocationUnavailable {
  available: false
}

export interface UserLocationAvailable {
  available: true
  lat: number
  lon: number
  accuracy_m: number
  address: string | null
  address_status: string
  timestamp: string
  trigger: string
  freshness: string
}

export type UserLocationResult = UserLocationUnavailable | UserLocationAvailable

export interface LocationHistoryEvent {
  id: string
  lat: number
  lon: number
  accuracy_m: number
  timestamp: string
  trigger: string
  source: string
  address: string | null
  address_source: string | null
  address_status: string
  created_at: string
}

export interface LocationHistoryResult {
  events: LocationHistoryEvent[]
  _links: ReturnType<typeof buildHalLinks>
}

export interface UserHealthSummaryResult {
  available: true
  username: string
  date: string
  timezone: string
  partial: boolean
  synced_at: string
  metrics: HealthMetrics
  finalized_at?: string | null
}

export type UserHealthTodayResult = UserHealthSummaryResult | { available: false; username: string }
export type UserHealthDailyResult =
  | UserHealthSummaryResult
  | { available: false; username: string; date: string }

export interface HealthHistorySummary {
  id: string
  date: string
  timezone: string
  partial: boolean
  finalized_at: string | null
  synced_at: string
  source: string
  metrics: HealthMetrics
}

export interface HealthHistoryResult {
  summaries: HealthHistorySummary[]
  _links: ReturnType<typeof buildHalLinks>
}

export interface CreateInviteResult {
  invite_id: string
  token: string
  expires_at: string
}

export interface CompanionUserSummary {
  id: string
  username: string
  created_at: string
}

export interface PendingInviteSummary {
  id: string
  type: string
  label: string | null
  expires_at: string
  created_at: string
}

export interface ListCompanionAccountsResult {
  users: CompanionUserSummary[]
  pending_invites: PendingInviteSummary[]
}

export interface RevokeInviteResult {
  ok: true
}

export interface CreateJobConversationResult {
  conversation_id: string
  kind: 'job'
}

export interface LinkJobConversationResult {
  conversation_id: string
  hermes_job_id: string
}

export interface McpToolHandlers {
  get_user_location(input: { username: string }): Promise<UserLocationResult>
  get_location_history(input: {
    username: string
    limit?: number
    before?: string
    after?: string
  }): Promise<LocationHistoryResult>
  get_user_health_today(input: { username: string }): Promise<UserHealthTodayResult>
  get_user_health_daily(input: { username: string; date: string }): Promise<UserHealthDailyResult>
  get_user_health_history(input: {
    username: string
    limit?: number
    before?: string
    after?: string
  }): Promise<HealthHistoryResult>
  create_companion_invite(input: { label?: string }): Promise<CreateInviteResult>
  create_password_reset_invite(input: { username: string }): Promise<CreateInviteResult>
  list_companion_accounts(): Promise<ListCompanionAccountsResult>
  revoke_companion_invite(input: { invite_id: string }): Promise<RevokeInviteResult>
  create_job_conversation(input: {
    username: string
    name: string
    schedule_display?: string
  }): Promise<CreateJobConversationResult>
  link_job_conversation(input: {
    username: string
    conversation_id: string
    hermes_job_id: string
    schedule_display?: string
    job_enabled?: boolean
  }): Promise<LinkJobConversationResult>
}

export function buildMcpToolHandlers(
  db: Database.Database,
  options: {
    inviteExpiryHours: number
  },
): McpToolHandlers {
  return {
    async get_user_location(input) {
      const user = resolveUserByUsername(db, input.username)
      const event = getLatestLocationEvent(db, user.id)
      if (!event) {
        return { available: false }
      }

      return serializeAvailableLocation(event)
    },

    async get_user_health_today(input) {
      const user = resolveUserByUsername(db, input.username)
      const row = getLatestHealthDailySummary(db, user.id)
      if (!row) {
        return { available: false, username: input.username }
      }

      return serializeHealthSummary(input.username, row)
    },

    async get_user_health_daily(input) {
      const user = resolveUserByUsername(db, input.username)
      const date = parseHealthDate(input.date)
      if (!date) {
        throw new Error('invalid_request')
      }

      const row = getHealthDailySummaryByDate(db, user.id, date)
      if (!row) {
        return { available: false, username: input.username, date }
      }

      return serializeHealthSummary(input.username, row)
    },

    async get_user_health_history(input) {
      if (input.before && input.after) {
        throw new Error('invalid_request')
      }

      const user = resolveUserByUsername(db, input.username)
      const limit = clampHistoryLimit(input.limit)
      const page = listHealthDailySummariesPage(db, user.id, limit, {
        before: input.before,
        after: input.after,
      })
      if (!page) {
        throw new Error('invalid_request')
      }

      const firstId = page.summaries[0]?.id
      const lastId = page.summaries[page.summaries.length - 1]?.id

      return {
        summaries: page.summaries.map(serializeHealthHistorySummary),
        _links: buildHalLinks({
          basePath: '/data/health/daily-summaries',
          limit,
          before: input.before,
          after: input.after,
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer,
          firstId,
          lastId,
        }),
      }
    },

    async get_location_history(input) {
      if (input.before && input.after) {
        throw new Error('invalid_request')
      }

      const user = resolveUserByUsername(db, input.username)
      const limit = clampHistoryLimit(input.limit)
      const page = listLocationEventsPage(db, user.id, limit, {
        before: input.before,
        after: input.after,
      })
      if (!page) {
        throw new Error('invalid_request')
      }

      const firstId = page.events[0]?.id
      const lastId = page.events[page.events.length - 1]?.id

      return {
        events: page.events.map(serializeHistoryEvent),
        _links: buildHalLinks({
          basePath: '/data/location/events',
          limit,
          before: input.before,
          after: input.after,
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer,
          firstId,
          lastId,
        }),
      }
    },

    async create_companion_invite(input) {
      const { invite, rawToken, expiresAt } = createInviteRecord(db, {
        type: 'activation',
        label: input.label,
        expiryHours: options.inviteExpiryHours,
      })

      return {
        invite_id: invite.id,
        token: rawToken,
        expires_at: expiresAt,
      }
    },

    async create_password_reset_invite(input) {
      const user = findUserByUsername(db, input.username)
      if (!user) {
        throw new Error(`User "${input.username}" not found`)
      }

      const { invite, rawToken, expiresAt } = createInviteRecord(db, {
        type: 'password_reset',
        userId: user.id,
        expiryHours: options.inviteExpiryHours,
      })

      return {
        invite_id: invite.id,
        token: rawToken,
        expires_at: expiresAt,
      }
    },

    async list_companion_accounts() {
      return {
        users: listUsers(db),
        pending_invites: listPendingInvites(db).map(serializePendingInvite),
      }
    },

    async revoke_companion_invite(input) {
      const revoked = revokeInvite(db, input.invite_id)
      if (!revoked) {
        throw new Error(`Invite "${input.invite_id}" not found or not revocable`)
      }

      return { ok: true }
    },

    async create_job_conversation(input) {
      const user = resolveUserByUsername(db, input.username)
      const name = input.name?.trim()
      if (!name) {
        throw new Error('invalid_request')
      }

      const conversationId = createJobConversation(db, user.id, input.username, {
        name,
        scheduleDisplay: input.schedule_display,
      })
      emitAccountConversationUpsert(db, user.id, conversationId)

      return {
        conversation_id: conversationId,
        kind: 'job' as const,
      }
    },

    async link_job_conversation(input) {
      const user = resolveUserByUsername(db, input.username)
      const hermesJobId = input.hermes_job_id?.trim()
      if (!hermesJobId || !input.conversation_id?.trim()) {
        throw new Error('invalid_request')
      }

      const linked = linkJobConversation(db, user.id, {
        conversationId: input.conversation_id.trim(),
        hermesJobId,
        scheduleDisplay: input.schedule_display,
        jobEnabled: input.job_enabled,
      })

      emitAccountConversationUpsert(db, user.id, linked.id)
      return serializeLinkedJobConversation(linked)
    },
  }
}

function serializeLinkedJobConversation(conversation: ConversationRow): LinkJobConversationResult {
  if (!conversation.hermes_job_id) {
    throw new Error('conversation_not_linked')
  }

  return {
    conversation_id: conversation.id,
    hermes_job_id: conversation.hermes_job_id,
  }
}

function resolveUserByUsername(db: Database.Database, username: string) {
  const user = findUserByUsername(db, username)
  if (!user) {
    throw new Error(`User "${username}" not found`)
  }

  return user
}

function serializePendingInvite(invite: AccountInviteRow): PendingInviteSummary {
  return {
    id: invite.id,
    type: invite.type,
    label: invite.label,
    expires_at: invite.expires_at,
    created_at: invite.created_at,
  }
}

function serializeAvailableLocation(event: LocationEventRow): UserLocationAvailable {
  return {
    available: true,
    lat: event.lat,
    lon: event.lon,
    accuracy_m: event.accuracy_m,
    address: event.address,
    address_status: event.address_status,
    timestamp: event.timestamp,
    trigger: event.trigger,
    freshness: formatFreshness(event.timestamp),
  }
}

function serializeHealthSummary(username: string, row: HealthDailySummaryRow): UserHealthSummaryResult {
  return {
    available: true,
    username,
    date: row.date,
    timezone: row.timezone,
    partial: row.partial === 1,
    synced_at: row.synced_at,
    metrics: parseStoredHealthMetrics(row.metrics_json),
    finalized_at: row.finalized_at,
  }
}

function serializeHealthHistorySummary(row: HealthDailySummaryRow): HealthHistorySummary {
  return {
    id: row.id,
    date: row.date,
    timezone: row.timezone,
    partial: row.partial === 1,
    finalized_at: row.finalized_at,
    synced_at: row.synced_at,
    source: row.source,
    metrics: parseStoredHealthMetrics(row.metrics_json),
  }
}

function serializeHistoryEvent(event: LocationEventRow): LocationHistoryEvent {
  return {
    id: event.id,
    lat: event.lat,
    lon: event.lon,
    accuracy_m: event.accuracy_m,
    timestamp: event.timestamp,
    trigger: event.trigger,
    source: event.source,
    address: event.address,
    address_source: event.address_source,
    address_status: event.address_status,
    created_at: event.created_at,
  }
}

function clampHistoryLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 20
  }

  if (!Number.isInteger(limit) || limit < 1) {
    return 20
  }

  return Math.min(limit, 100)
}