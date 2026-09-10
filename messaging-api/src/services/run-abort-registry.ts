export class RunAbortRegistry {
  private readonly controllers = new Map<string, AbortController>()
  private readonly reasons = new Map<string, string>()

  start(conversationId: string): AbortSignal {
    this.abort(conversationId)
    this.reasons.delete(conversationId)
    const controller = new AbortController()
    this.controllers.set(conversationId, controller)
    return controller.signal
  }

  abort(conversationId: string, reason = 'abort'): boolean {
    const current = this.controllers.get(conversationId)
    if (!current) return false
    this.reasons.set(conversationId, reason)
    current.abort()
    return true
  }

  reason(conversationId: string): string | undefined {
    return this.reasons.get(conversationId)
  }

  finish(conversationId: string, signal: AbortSignal): void {
    const current = this.controllers.get(conversationId)
    if (current?.signal === signal) {
      this.controllers.delete(conversationId)
      this.reasons.delete(conversationId)
    }
  }
}
