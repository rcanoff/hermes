import type { ToolingLine, ToolingPhase } from '../db/repos/process.js'

export type { ToolingLine, ToolingPhase } from '../db/repos/process.js'

export type LegacyStreamEvent =
  | { event: 'rewind'; data: { removedMessageIds: string[] } }
  | { event: 'process'; data: ToolingLine }
  | { event: 'process_token'; data: { phase: 'reasoning'; text: string } }
  | { event: 'process_complete'; data: Record<string, never> }
  | { event: 'token'; data: { text: string } }
  | { event: 'title'; data: { title: string } }
  | { event: 'done'; data: { messageId: string } }
  | { event: 'error'; data: { code: string } }

export type SessionStreamEvent =
  | {
      event: 'tooling'
      data: {
        conversationId: string
        runId: string
        phase?: ToolingPhase | 'complete'
        text?: string
        tool?: string | null
        args?: Record<string, unknown> | null
        draft?: true
      }
    }
  | {
      event: 'reply'
      data: {
        conversationId: string
        runId: string
        text?: string
        phase?: 'done'
        messageId?: string
      }
    }
  | { event: 'title'; data: { conversationId: string; title: string } }
  | {
      event: 'rewind'
      data: { conversationId: string; runId: string; removedMessageIds: string[] }
    }
  | { event: 'error'; data: { conversationId: string; runId: string; code: string } }

type SessionListener = (event: SessionStreamEvent) => void
type LegacyListener = (event: LegacyStreamEvent) => void

export class StreamHub {
  private readonly sessionListeners = new Map<string, SessionListener>()
  private readonly legacyListeners = new Map<string, Set<LegacyListener>>()
  private readonly pendingRewinds = new Map<string, string[]>()
  private readonly userSessions = new Map<string, Set<string>>()
  private readonly sessionUser = new Map<string, string>()

  subscribeSession(sessionId: string, listener: SessionListener): () => void {
    this.sessionListeners.set(sessionId, listener)
    return () => {
      if (this.sessionListeners.get(sessionId) === listener) {
        this.sessionListeners.delete(sessionId)
      }
    }
  }

  hasSessionListener(sessionId: string): boolean {
    return this.sessionListeners.has(sessionId)
  }

  registerUserSession(userId: string, sessionId: string): void {
    const sessions = this.userSessions.get(userId) ?? new Set<string>()
    sessions.add(sessionId)
    this.userSessions.set(userId, sessions)
    this.sessionUser.set(sessionId, userId)
  }

  unregisterUserSession(sessionId: string): void {
    const userId = this.sessionUser.get(sessionId)
    if (!userId) return
    this.sessionUser.delete(sessionId)
    const sessions = this.userSessions.get(userId)
    sessions?.delete(sessionId)
    if (sessions?.size === 0) {
      this.userSessions.delete(userId)
    }
  }

  hasUserSessionListener(userId: string): boolean {
    const sessions = this.userSessions.get(userId)
    if (!sessions) return false
    for (const sessionId of sessions) {
      if (this.sessionListeners.has(sessionId)) return true
    }
    return false
  }

  publishToUser(userId: string, event: SessionStreamEvent): void {
    const sessions = this.userSessions.get(userId)
    if (!sessions) return
    for (const sessionId of sessions) {
      this.publishSession(sessionId, event)
    }
  }

  replaceSessionConnection(sessionId: string, listener: SessionListener): () => void {
    const previous = this.sessionListeners.get(sessionId)
    if (previous) {
      this.sessionListeners.delete(sessionId)
    }
    return this.subscribeSession(sessionId, listener)
  }

  publishSession(sessionId: string, event: SessionStreamEvent): void {
    this.deliverSessionEvent(sessionId, event)
  }

  private deliverSessionEvent(sessionId: string, event: SessionStreamEvent): void {
    const listener = this.sessionListeners.get(sessionId)
    if (!listener) {
      return
    }
    try {
      listener(event)
    } catch {
      this.sessionListeners.delete(sessionId)
    }
  }

  setPendingRewind(conversationId: string, removedMessageIds: string[]): void {
    this.pendingRewinds.set(conversationId, removedMessageIds)
  }

  subscribeLegacy(conversationId: string, listener: LegacyListener): () => void {
    const listeners = this.legacyListeners.get(conversationId) ?? new Set<LegacyListener>()
    listeners.add(listener)
    this.legacyListeners.set(conversationId, listeners)

    const pendingRewind = this.pendingRewinds.get(conversationId)
    if (pendingRewind) {
      this.pendingRewinds.delete(conversationId)
      listener({ event: 'rewind', data: { removedMessageIds: pendingRewind } })
    }

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.legacyListeners.delete(conversationId)
      }
    }
  }

  publishLegacy(conversationId: string, event: LegacyStreamEvent): void {
    const listeners = this.legacyListeners.get(conversationId)
    if (!listeners) {
      return
    }

    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        listeners.delete(listener)
      }
    }

    if (listeners.size === 0) {
      this.legacyListeners.delete(conversationId)
    }
  }

  /** @deprecated use subscribeLegacy */
  subscribe(conversationId: string, listener: LegacyListener): () => void {
    return this.subscribeLegacy(conversationId, listener)
  }

  /** @deprecated use publishLegacy */
  publish(conversationId: string, event: LegacyStreamEvent): void {
    this.publishLegacy(conversationId, event)
  }
}

/** @deprecated use LegacyStreamEvent */
export type StreamEvent = LegacyStreamEvent