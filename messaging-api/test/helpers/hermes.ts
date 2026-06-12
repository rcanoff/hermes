import type { HermesClient, HermesStreamEvent, StreamChatInput } from '../../src/services/hermes-client.js'

type QueueEntry =
  | { kind: 'event'; event: HermesStreamEvent }
  | { kind: 'error'; error: Error }
  | { kind: 'close' }

export class FakeHermesClient implements HermesClient {
  readonly requests: StreamChatInput[] = []

  private readonly queue: QueueEntry[] = []
  private waiters: Array<() => void> = []

  pushToken(text: string): void {
    this.push({ kind: 'event', event: { type: 'token', text } })
  }

  pushTool(name: string): void {
    this.push({ kind: 'event', event: { type: 'tool', name } })
  }

  pushDone(): void {
    this.push({ kind: 'event', event: { type: 'done' } })
  }

  closeWithoutDone(): void {
    this.push({ kind: 'close' })
  }

  fail(error: Error): void {
    this.push({ kind: 'error', error })
  }

  async *streamChat(input: StreamChatInput): AsyncIterable<HermesStreamEvent> {
    this.requests.push(input)

    while (true) {
      const entry = await this.nextEntry()

      if (entry.kind === 'event') {
        yield entry.event
        continue
      }

      if (entry.kind === 'error') {
        throw entry.error
      }

      return
    }
  }

  private push(entry: QueueEntry): void {
    this.queue.push(entry)
    const waiter = this.waiters.shift()
    waiter?.()
  }

  private async nextEntry(): Promise<QueueEntry> {
    if (this.queue.length > 0) {
      return this.queue.shift() as QueueEntry
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })

    return this.queue.shift() as QueueEntry
  }
}
