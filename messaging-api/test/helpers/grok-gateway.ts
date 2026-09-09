import type {
  GrokGatewayClient,
  GrokGatewayEvent,
  GrokInputAction,
} from '../../src/services/grok-gateway-client.js'
import { GrokGatewayError } from '../../src/services/grok-gateway-client.js'

type QueueEntry =
  | { kind: 'event'; event: GrokGatewayEvent }
  | { kind: 'error'; error: Error }
  | { kind: 'close' }

export class FakeGrokGatewayClient implements GrokGatewayClient {
  readonly putSessions: Array<{ conversationId: string; soul: string; cwd?: string }> = []
  readonly prompts: Array<{ conversationId: string; text: string; user_id: string }> = []
  readonly inputs: Array<{
    conversationId: string
    input_id: string
    action: GrokInputAction
    text?: string
  }> = []
  readonly deletes: string[] = []
  down = false

  private readonly queues = new Map<number, QueueEntry[]>()
  private readonly waiters = new Map<number, Array<() => void>>()
  private readonly preStartQueue: QueueEntry[] = []
  private nextStreamId = 0

  async health(): Promise<{ ok: true; grok: 'up' | 'down' }> {
    return { ok: true, grok: this.down ? 'down' : 'up' }
  }

  async putSession(conversationId: string, body: { soul: string; cwd?: string }): Promise<void> {
    if (this.down) {
      throw new GrokGatewayError('grok_unavailable')
    }
    this.putSessions.push({ conversationId, soul: body.soul, cwd: body.cwd })
  }

  async *prompt(
    conversationId: string,
    body: { text: string; user_id: string },
  ): AsyncIterable<GrokGatewayEvent> {
    if (this.down) {
      throw new GrokGatewayError('grok_unavailable')
    }

    const streamId = this.nextStreamId++
    this.prompts.push({ conversationId, text: body.text, user_id: body.user_id })
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

  async resolveInput(
    conversationId: string,
    body: { input_id: string; action: GrokInputAction; text?: string },
  ): Promise<void> {
    if (this.down) {
      throw new GrokGatewayError('grok_unavailable')
    }
    this.inputs.push({
      conversationId,
      input_id: body.input_id,
      action: body.action,
      text: body.text,
    })
  }

  async deleteSession(conversationId: string): Promise<void> {
    this.deletes.push(conversationId)
  }

  pushEvent(event: GrokGatewayEvent, streamId = 0): void {
    this.enqueue(streamId, { kind: 'event', event })
  }

  pushDone(streamId = 0): void {
    this.pushEvent({ type: 'done' }, streamId)
  }

  close(streamId = 0): void {
    this.enqueue(streamId, { kind: 'close' })
  }

  fail(error: Error = new GrokGatewayError('grok_unavailable'), streamId = 0): void {
    this.enqueue(streamId, { kind: 'error', error })
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
      return queue.shift()!
    }

    await new Promise<void>((resolve) => {
      this.waiters.get(streamId)?.push(resolve)
    })
    return this.nextEntry(streamId)
  }
}
