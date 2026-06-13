import type Database from 'better-sqlite3'
import { findUserByUsername } from '../db/repos/users.js'
import {
  getLatestLocationEvent,
  listLocationEvents,
  type LocationEventRow,
} from '../db/repos/location-events.js'
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

export interface McpToolHandlers {
  get_user_location(): Promise<UserLocationResult>
  get_location_history(input: { limit?: number; before?: string }): Promise<LocationHistoryResult>
}

export function buildMcpToolHandlers(
  db: Database.Database,
  bootstrapUsername: string,
): McpToolHandlers {
  const operatorUser = findUserByUsername(db, bootstrapUsername)
  if (!operatorUser) {
    throw new Error(`Bootstrap user "${bootstrapUsername}" not found`)
  }

  const userId = operatorUser.id

  return {
    async get_user_location() {
      const event = getLatestLocationEvent(db, userId)
      if (!event) {
        return { available: false }
      }

      return serializeAvailableLocation(event)
    },

    async get_location_history(input) {
      const limit = clampHistoryLimit(input.limit)
      const events = listLocationEvents(db, userId, limit, input.before)
      return {
        events: events.map(serializeHistoryEvent),
      }
    },
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