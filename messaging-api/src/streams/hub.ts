export type ProcessLineKind = 'reasoning' | 'tool'

export type StreamEvent =
  | { event: 'rewind'; data: { removedMessageIds: string[] } }
  | { event: 'process'; data: { kind: ProcessLineKind; text: string } }
  | { event: 'process_token'; data: { kind: 'reasoning'; text: string } }
  | { event: 'process_complete'; data: Record<string, never> }
  | { event: 'token'; data: { text: string } }
  | { event: 'title'; data: { title: string } }
  | { event: 'done'; data: { messageId: string } }
  | { event: 'error'; data: { code: string } }

export type StreamListener = (event: StreamEvent) => void

export class StreamHub {
  private readonly listeners = new Map<string, Set<StreamListener>>()
  private readonly pendingRewinds = new Map<string, string[]>()

  setPendingRewind(conversationId: string, removedMessageIds: string[]): void {
    this.pendingRewinds.set(conversationId, removedMessageIds)
  }

  subscribe(conversationId: string, listener: StreamListener): () => void {
    const listeners = this.listeners.get(conversationId) ?? new Set<StreamListener>()
    listeners.add(listener)
    this.listeners.set(conversationId, listeners)

    const pendingRewind = this.pendingRewinds.get(conversationId)
    if (pendingRewind) {
      this.pendingRewinds.delete(conversationId)
      listener({ event: 'rewind', data: { removedMessageIds: pendingRewind } })
    }

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(conversationId)
      }
    }
  }

  publish(conversationId: string, event: StreamEvent): void {
    const listeners = this.listeners.get(conversationId)
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
      this.listeners.delete(conversationId)
    }
  }
}
