import type {
  CompleteChatInput,
  HermesClient,
  HermesStreamEvent,
  StreamChatInput,
} from '../../src/services/hermes-client.js'

type QueueEntry =
  | { kind: 'event'; event: HermesStreamEvent }
  | { kind: 'error'; error: Error }
  | { kind: 'close' }

export class FakeHermesClient implements HermesClient {
  readonly requests: StreamChatInput[] = []
  readonly completeRequests: CompleteChatInput[] = []

  private readonly queues = new Map<number, QueueEntry[]>()
  private readonly waiters = new Map<number, Array<() => void>>()
  private readonly preStartQueue: QueueEntry[] = []
  private nextStreamId = 0

  pushReasoning(text: string, streamId = 0): void {
    this.enqueue(streamId, { kind: 'event', event: { type: 'reasoning', text } })
  }

  pushToolCall(name: string, args: string, streamId = 0): void {
    this.enqueue(streamId, { kind: 'event', event: { type: 'tool', name, arguments: args } })
  }

  pushAnswerToken(text: string, streamId = 0): void {
    this.enqueue(streamId, { kind: 'event', event: { type: 'answer_token', text } })
  }

  pushDone(streamId = 0): void {
    this.enqueue(streamId, { kind: 'event', event: { type: 'done' } })
  }

  closeWithoutDone(streamId = 0): void {
    this.enqueue(streamId, { kind: 'close' })
  }

  fail(error: Error, streamId = 0): void {
    this.enqueue(streamId, { kind: 'error', error })
  }

  async completeChat(input: CompleteChatInput): Promise<string> {
    this.completeRequests.push(input)
    return ''
  }

  async *streamChat(input: StreamChatInput): AsyncIterable<HermesStreamEvent> {
    const streamId = this.nextStreamId++
    this.requests.push(input)
    const initialQueue = streamId === 0 && this.preStartQueue.length > 0 ? [...this.preStartQueue] : []
    if (streamId === 0) {
      this.preStartQueue.length = 0
    }
    this.queues.set(streamId, initialQueue)
    this.waiters.set(streamId, [])

    while (true) {
      const entry = await this.nextEntry(streamId)

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

  private enqueue(streamId: number, entry: QueueEntry): void {
    if (streamId === 0 && !this.queues.has(0)) {
      this.preStartQueue.push(entry)
      return
    }

    const queue = this.queues.get(streamId)
    if (!queue) {
      throw new Error(`Unknown stream id ${streamId}`)
    }

    queue.push(entry)
    const waiter = this.waiters.get(streamId)?.shift()
    waiter?.()
  }

  private async nextEntry(streamId: number): Promise<QueueEntry> {
    const queue = this.queues.get(streamId)
    if (!queue) {
      throw new Error(`Unknown stream id ${streamId}`)
    }

    if (queue.length > 0) {
      return queue.shift() as QueueEntry
    }

    await new Promise<void>((resolve) => {
      this.waiters.get(streamId)?.push(resolve)
    })

    return queue.shift() as QueueEntry
  }
}