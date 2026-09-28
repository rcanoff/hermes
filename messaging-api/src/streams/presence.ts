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
/** How often account streams are checked for a missing heartbeat. */
export const PRESENCE_SWEEP_INTERVAL_MS = 15_000
/** An account stream with no heartbeat (or connect) for this long is treated as disconnected. */
export const PRESENCE_HEARTBEAT_TIMEOUT_MS = 45_000

/**
 * Online = at least one account stream connected (in memory: a fresh process has nobody online).
 * Each online/offline transition is published to every other connected user.
 * A stream counts as connected only while the client proves it alive: a half-open TCP connection accepts the
 * server's writes, so a stream without a heartbeat for PRESENCE_HEARTBEAT_TIMEOUT_MS is closed and disconnected.
 */
export class PresenceTracker {
  private readonly online = new Set<string>()
  private readonly pendingOffline = new Map<string, unknown>()
  /** Set by close(): streams that end while the app shuts down schedule no timers and write nothing. */
  private closed = false
  private sweepTimer: unknown

  constructor(
    private readonly db: Database.Database,
    private readonly hub: StreamHub,
    private readonly clock: PresenceClock,
  ) {
    this.scheduleSweep()
  }

  isOnline(userId: string): boolean {
    return this.online.has(userId)
  }

  /** Call after the hub registered the user's stream; the connect counts as the session's first heartbeat. */
  connected(userId: string, sessionId: string): void {
    if (this.closed) return
    const now = this.clock.now()
    const at = now.toISOString()
    this.hub.touchHeartbeat(sessionId, now)
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

  /**
   * The client confirmed its account stream is alive. False when the session has no registered stream (the sweep
   * dropped it, or it never connected): the client's stream is dead and must be reopened.
   */
  heartbeat(sessionId: string): boolean {
    if (this.closed) return true
    return this.hub.touchHeartbeat(sessionId, this.clock.now())
  }

  /** Call after the hub released the user's stream. */
  disconnected(userId: string): void {
    if (this.closed || !this.online.has(userId) || this.pendingOffline.has(userId)) return
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
    this.closed = true
    this.clock.clearTimeout(this.sweepTimer)
    for (const timer of this.pendingOffline.values()) this.clock.clearTimeout(timer)
    this.pendingOffline.clear()
  }

  private scheduleSweep(): void {
    this.sweepTimer = this.clock.setTimeout(() => {
      if (this.closed) return
      const cutoff = new Date(this.clock.now().getTime() - PRESENCE_HEARTBEAT_TIMEOUT_MS)
      for (const userId of this.hub.closeStaleUserSessions(cutoff)) this.disconnected(userId)
      this.scheduleSweep()
    }, PRESENCE_SWEEP_INTERVAL_MS)
  }

  private publish(userId: string, online: boolean, at: string): void {
    this.hub.publishToAllExcept(userId, {
      event: 'presence',
      data: { user_id: userId, online, last_seen_at: at },
    })
  }
}
