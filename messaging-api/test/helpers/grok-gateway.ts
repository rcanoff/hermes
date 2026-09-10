import type {
  GrokGatewayClient,
  GrokGatewayEvent,
  GrokInputAction,
  GrokOutboxEvent,
  GrokOutboxItem,
  GrokOutboxSnapshot,
} from '../../src/services/grok-gateway-client.js'
import { GrokGatewayError } from '../../src/services/grok-gateway-client.js'

type QueueEntry =
  | { kind: 'event'; event: GrokGatewayEvent }
  | { kind: 'error'; error: Error }
  | { kind: 'close' }

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

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
  readonly cancels: string[] = []
  readonly acks: Array<{ conversationId: string; through: number }> = []
  down = false
  nextPromptError: Error | null = null
  private readonly outboxEvents = new Map<string, GrokOutboxItem[]>()
  private readonly promptInFlightOverride = new Map<string, boolean>()

  private readonly queues = new Map<number, QueueEntry[]>()
  private readonly waiters = new Map<number, Array<() => void>>()
  private readonly preStartQueue: QueueEntry[] = []
  private nextStreamId = 0
  private readonly openStreams = new Map<string, number>()
  private readonly inFlight = new Set<string>()

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
    signal?: AbortSignal,
  ): AsyncIterable<GrokGatewayEvent> {
    if (this.down) {
      throw new GrokGatewayError('grok_unavailable')
    }

    this.prompts.push({ conversationId, text: body.text, user_id: body.user_id })

    if (this.nextPromptError) {
      const error = this.nextPromptError
      this.nextPromptError = null
      throw error
    }

    if (this.inFlight.has(conversationId)) {
      throw new GrokGatewayError('prompt_in_flight')
    }

    const streamId = this.nextStreamId++
    const initialQueue = streamId === 0 && this.preStartQueue.length > 0 ? [...this.preStartQueue] : []
    if (streamId === 0) {
      this.preStartQueue.length = 0
    }
    this.queues.set(streamId, initialQueue)
    this.waiters.set(streamId, [])
    this.openStreams.set(conversationId, streamId)
    this.inFlight.add(conversationId)

    const abort = () => this.abortStream(streamId)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
    }

    try {
      while (true) {
        const entry = await this.nextEntry(streamId)
        if (entry.kind === 'event') {
          yield entry.event
          continue
        }
        if (entry.kind === 'error') {
          throw entry.error
        }
        this.inFlight.delete(conversationId)
        return
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        this.inFlight.delete(conversationId)
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.openStreams.delete(conversationId)
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

  async cancelPrompt(conversationId: string): Promise<void> {
    this.cancels.push(conversationId)
    this.inFlight.delete(conversationId)
    const streamId = this.openStreams.get(conversationId)
    if (streamId !== undefined) {
      this.abortStream(streamId)
    }
  }

  async deleteSession(conversationId: string): Promise<void> {
    this.deletes.push(conversationId)
  }

  async fetchOutbox(conversationId: string, afterSeq = 0): Promise<GrokOutboxSnapshot> {
    if (this.down) {
      throw new GrokGatewayError('grok_unavailable')
    }

    const all = this.outboxEvents.get(conversationId) ?? []
    const events = all.filter((item) => item.seq > afterSeq)
    const last_seq = all.at(-1)?.seq ?? afterSeq
    const prompt_in_flight =
      this.promptInFlightOverride.get(conversationId) ?? this.inFlight.has(conversationId)
    return { events, last_seq, prompt_in_flight }
  }

  async ackOutbox(conversationId: string, through: number): Promise<void> {
    if (this.down) {
      throw new GrokGatewayError('grok_unavailable')
    }

    this.acks.push({ conversationId, through })
    const all = this.outboxEvents.get(conversationId) ?? []
    this.outboxEvents.set(
      conversationId,
      all.filter((item) => item.seq > through),
    )
  }

  setOutbox(conversationId: string, events: GrokOutboxEvent[]): void {
    this.outboxEvents.set(
      conversationId,
      events.map((event, index) => ({
        seq: index + 1,
        ts: new Date().toISOString(),
        event,
      })),
    )
  }

  setPromptInFlight(conversationId: string, value: boolean): void {
    this.promptInFlightOverride.set(conversationId, value)
  }

  private abortStream(streamId: number): void {
    if (!this.queues.has(streamId)) {
      return
    }
    this.enqueue(streamId, { kind: 'error', error: abortError() })
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
