export type StreamEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'tool'; data: { name: string } }
  | { event: 'done'; data: { messageId: string } }
  | { event: 'error'; data: { code: string } }

export type StreamListener = (event: StreamEvent) => void

export class StreamHub {
  private readonly listeners = new Map<string, Set<StreamListener>>()

  subscribe(conversationId: string, listener: StreamListener): () => void {
    const listeners = this.listeners.get(conversationId) ?? new Set<StreamListener>()
    listeners.add(listener)
    this.listeners.set(conversationId, listeners)

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
