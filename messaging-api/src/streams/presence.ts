import type Database from 'better-sqlite3'
import { touchUserLastSeen } from '../db/repos/users.js'
import type { StreamHub } from './hub.js'

export type PresenceEvent = {
  event: 'presence'
  data: { user_id: string; online: boolean; last_seen_at: string }
}

export interface PresenceClock {
  now(): Date
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemPresenceClock: PresenceClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** A user whose last stream closed stays online this long, so a reconnect does not flap. */
export const PRESENCE_OFFLINE_DEBOUNCE_MS = 5_000

/**
 * Online = at least one account stream connected (in memory: a fresh process has nobody online).
 * Each online/offline transition is published to every other connected user.
 */
export class PresenceTracker {
  private readonly online = new Set<string>()
  private readonly pendingOffline = new Map<string, unknown>()

  constructor(
    private readonly db: Database.Database,
    private readonly hub: StreamHub,
    private readonly clock: PresenceClock,
  ) {}

  isOnline(userId: string): boolean {
    return this.online.has(userId)
  }

  /** Call after the hub registered the user's stream. */
  connected(userId: string): void {
    const at = this.clock.now().toISOString()
    touchUserLastSeen(this.db, userId, at)
    const pending = this.pendingOffline.get(userId)
    if (pending !== undefined) {
      this.clock.clearTimeout(pending)
      this.pendingOffline.delete(userId)
    }
    if (this.online.has(userId)) return
    this.online.add(userId)
    this.publish(userId, true, at)
  }

  /** Call after the hub released the user's stream. */
  disconnected(userId: string): void {
    if (!this.online.has(userId) || this.pendingOffline.has(userId)) return
    if (this.hub.countUserSessions(userId) > 0) return
    const timer = this.clock.setTimeout(() => {
      this.pendingOffline.delete(userId)
      if (this.hub.countUserSessions(userId) > 0) return
      const at = this.clock.now().toISOString()
      this.online.delete(userId)
      touchUserLastSeen(this.db, userId, at)
      this.publish(userId, false, at)
    }, PRESENCE_OFFLINE_DEBOUNCE_MS)
    this.pendingOffline.set(userId, timer)
  }

  close(): void {
    for (const timer of this.pendingOffline.values()) this.clock.clearTimeout(timer)
    this.pendingOffline.clear()
  }

  private publish(userId: string, online: boolean, at: string): void {
    this.hub.publishToAllExcept(userId, {
      event: 'presence',
      data: { user_id: userId, online, last_seen_at: at },
    })
  }
}
