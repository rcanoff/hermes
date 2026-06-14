import type Database from 'better-sqlite3'
import {
  listPendingInvites,
  listUsers,
  revokeInvite,
  type AccountInviteRow,
} from '../db/repos/account-invites.js'
import { findUserByUsername } from '../db/repos/users.js'
import {
  getLatestLocationEvent,
  listLocationEvents,
  type LocationEventRow,
} from '../db/repos/location-events.js'
import { buildInviteUrl, createInviteRecord } from './invites.js'
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
}

export interface CreateInviteResult {
  invite_id: string
  url: string
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

export interface McpToolHandlers {
  get_user_location(input: { username: string }): Promise<UserLocationResult>
  get_location_history(input: {
    username: string
    limit?: number
    before?: string
  }): Promise<LocationHistoryResult>
  create_companion_invite(input: { label?: string }): Promise<CreateInviteResult>
  create_password_reset_invite(input: { username: string }): Promise<CreateInviteResult>
  list_companion_accounts(): Promise<ListCompanionAccountsResult>
  revoke_companion_invite(input: { invite_id: string }): Promise<RevokeInviteResult>
}

export function buildMcpToolHandlers(
  db: Database.Database,
  options: {
    messagingApiHost: string
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

    async get_location_history(input) {
      const user = resolveUserByUsername(db, input.username)
      const limit = clampHistoryLimit(input.limit)
      const events = listLocationEvents(db, user.id, limit, input.before)
      return {
        events: events.map(serializeHistoryEvent),
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
        url: buildInviteUrl(options.messagingApiHost, rawToken),
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
        url: buildInviteUrl(options.messagingApiHost, rawToken),
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