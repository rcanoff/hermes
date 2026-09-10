export class RunAbortRegistry {
  private readonly controllers = new Map<string, AbortController>()

  start(conversationId: string): AbortSignal {
    this.abort(conversationId)
    const controller = new AbortController()
    this.controllers.set(conversationId, controller)
    return controller.signal
  }

  abort(conversationId: string): boolean {
    const current = this.controllers.get(conversationId)
    if (!current) return false
    current.abort()
    return true
  }

  finish(conversationId: string, signal: AbortSignal): void {
    const current = this.controllers.get(conversationId)
    if (current?.signal === signal) {
      this.controllers.delete(conversationId)
    }
  }
}
