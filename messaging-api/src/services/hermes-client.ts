import type { HermesPromptMessage } from './prompt-builder.js'
import {
  openHermesStateDbRw,
  updateSessionModel,
  upsertCompanionSession,
} from './hermes-session-store.js'

/** Stable Hermes gateway session key — identifies messaging-api traffic as Companion App. */
export const COMPANION_APP_SESSION_KEY = 'companion-app'

/** Prefix for per-conversation Hermes sessions used in one-shot title generation. */
export const COMPANION_TITLE_GENERATION_SESSION_KEY = 'companion-title-generation'

export function buildTitleGenerationSessionKey(conversationId: string): string {
  return `${COMPANION_TITLE_GENERATION_SESSION_KEY}:${conversationId}`
}

/** Stable Hermes session for companion cron prompt synthesis (non-agent completeChat). */
export const COMPANION_CRON_PROMPT_SYNTHESIS_SESSION_KEY = 'companion-cron-prompt-synthesis'

export interface StreamChatInput {
  hermesSessionId: string
  messages: HermesPromptMessage[]
}

export interface CompleteChatInput {
  hermesSessionId: string
  messages: HermesPromptMessage[]
}

export interface EnsureSessionInput {
  hermesSessionId: string
  systemPrompt?: string | null
  model?: string
  provider?: string
}

export interface PatchSessionModelInput {
  hermesSessionId: string
  model: string
  provider: string
}

export interface HermesStreamEvent {
  type: 'reasoning' | 'tool' | 'tool_complete' | 'answer_token' | 'done'
  text?: string
  name?: string
  arguments?: string
  label?: string
}

export interface HermesClient {
  streamChat(input: StreamChatInput): AsyncIterable<HermesStreamEvent>
  completeChat(input: CompleteChatInput): Promise<string>
  ensureSession(input: EnsureSessionInput): Promise<void>
  patchSessionModel(input: PatchSessionModelInput): Promise<void>
}

interface OpenAiChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null
    }
  }>
}

interface OpenAiChatChunk {
  choices?: Array<{
    delta?: {
      reasoning_content?: string
      content?: string | Array<{ type?: string; text?: string }>
      tool_calls?: Array<{
        index?: number
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
}

interface ToolCallBuffer {
  name?: string
  arguments: string
}

interface HermesToolProgressPayload {
  tool?: string
  label?: string
  toolCallId?: string
  status?: string
}

export class HermesToolProgressTracker {
  private readonly running = new Map<string, { tool: string; label?: string }>()

  ingest(payload: HermesToolProgressPayload): HermesStreamEvent[] {
    if (!payload.tool || !payload.toolCallId) {
      return []
    }

    if (payload.status === 'running') {
      if (this.running.has(payload.toolCallId)) {
        return []
      }

      const label = typeof payload.label === 'string' ? payload.label : undefined
      this.running.set(payload.toolCallId, { tool: payload.tool, label })
      return [{ type: 'tool', name: payload.tool, label }]
    }

    if (payload.status === 'completed') {
      const started = this.running.get(payload.toolCallId)
      this.running.delete(payload.toolCallId)
      if (!started) {
        return []
      }

      return [{ type: 'tool_complete', name: started.tool, label: started.label }]
    }

    return []
  }
}

export class ToolCallAccumulator {
  private readonly buffers = new Map<number, ToolCallBuffer>()

  ingest(
    toolCalls: Array<{
      index?: number
      function?: {
        name?: string
        arguments?: string
      }
    }>,
  ): HermesStreamEvent[] {
    const events: HermesStreamEvent[] = []

    for (const toolCall of toolCalls) {
      const index = toolCall.index ?? 0
      const buffer = this.buffers.get(index) ?? { arguments: '' }

      if (toolCall.function?.name) {
        buffer.name = toolCall.function.name
      }

      if (toolCall.function?.arguments) {
        buffer.arguments += toolCall.function.arguments
      }

      this.buffers.set(index, buffer)

      if (buffer.name && buffer.arguments) {
        try {
          JSON.parse(buffer.arguments)
          events.push({
            type: 'tool',
            name: buffer.name,
            arguments: buffer.arguments,
          })
          this.buffers.delete(index)
        } catch {
          // Incomplete JSON; keep buffering.
        }
      }
    }

    return events
  }
}

export class OpenAiHermesClient implements HermesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey = '',
    private readonly hermesStateDbPath?: string,
  ) {}

  private syncSessionModelToStateDb(input: {
    hermesSessionId: string
    model?: string
    provider?: string
    systemPrompt?: string | null
  }): void {
    if (!this.hermesStateDbPath || !input.model || !input.provider) {
      return
    }

    const db = openHermesStateDbRw(this.hermesStateDbPath)
    if (!db) {
      return
    }

    try {
      upsertCompanionSession(db, {
        sessionId: input.hermesSessionId,
        model: input.model,
        provider: input.provider,
        systemPrompt: input.systemPrompt,
      })
    } finally {
      db.close()
    }
  }

  async ensureSession(input: EnsureSessionInput): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-hermes-session-key': COMPANION_APP_SESSION_KEY,
    }

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`
    }

    const body: Record<string, string> = { id: input.hermesSessionId }
    const systemPrompt = input.systemPrompt?.trim()
    if (systemPrompt) {
      body.system_prompt = systemPrompt
    }
    if (input.model) {
      body.model = input.model
    }
    if (input.provider) {
      body.provider = input.provider
    }

    const response = await fetch(new URL('/api/sessions', this.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (response.status === 409 || response.ok) {
      this.syncSessionModelToStateDb({
        hermesSessionId: input.hermesSessionId,
        model: input.model,
        provider: input.provider,
        systemPrompt: input.systemPrompt,
      })
    }

    if (response.status === 409) {
      return
    }

    if (!response.ok) {
      throw new Error(`Hermes session warmup failed with status ${response.status}`)
    }
  }

  async patchSessionModel(input: PatchSessionModelInput): Promise<void> {
    if (!this.hermesStateDbPath) {
      throw new Error('Hermes state database path is not configured')
    }

    const db = openHermesStateDbRw(this.hermesStateDbPath)
    if (!db) {
      throw new Error('Hermes state database unavailable')
    }

    try {
      updateSessionModel(db, {
        sessionId: input.hermesSessionId,
        model: input.model,
        provider: input.provider,
      })
    } finally {
      db.close()
    }
  }

  async completeChat(input: CompleteChatInput): Promise<string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-hermes-session-id': input.hermesSessionId,
      'x-hermes-session-key': COMPANION_APP_SESSION_KEY,
    }

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`
    }

    const response = await fetch(new URL('/v1/chat/completions', this.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: input.messages,
        stream: false,
      }),
    })

    if (!response.ok) {
      throw new Error(`Hermes request failed with status ${response.status}`)
    }

    const payload = (await response.json()) as OpenAiChatCompletion
    const content = payload.choices?.[0]?.message?.content
    return extractCompletionText(content)
  }

  async *streamChat(input: StreamChatInput): AsyncIterable<HermesStreamEvent> {
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'x-hermes-session-id': input.hermesSessionId,
      'x-hermes-session-key': COMPANION_APP_SESSION_KEY,
    }

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`
    }

    const response = await fetch(new URL('/v1/chat/completions', this.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: input.messages,
        stream: true,
      }),
    })

    if (!response.ok || !response.body) {
      throw new Error(`Hermes request failed with status ${response.status}`)
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let sawDone = false
    const toolCallAccumulator = new ToolCallAccumulator()
    const toolProgressTracker = new HermesToolProgressTracker()

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })

      while (true) {
        const extraction = extractSseFrame(buffer)
        if (!extraction) {
          break
        }

        buffer = extraction.rest

        for (const event of parseSseEvent(extraction.frame, toolCallAccumulator, toolProgressTracker)) {
          if (event.type === 'done') {
            sawDone = true
          }
          yield event
        }
      }
    }

    buffer += decoder.decode()

    if (buffer.trim()) {
      throw new Error('Hermes stream ended without a done event')
    }

    if (!sawDone) {
      throw new Error('Hermes stream ended without a done event')
    }
  }
}

export function parseHermesSsePayload(
  rawEvent: string,
  accumulator: ToolCallAccumulator = new ToolCallAccumulator(),
  progressTracker: HermesToolProgressTracker = new HermesToolProgressTracker(),
): HermesStreamEvent[] {
  return [...parseSseEvent(rawEvent, accumulator, progressTracker)]
}

function* parseSseEvent(
  rawEvent: string,
  toolCallAccumulator: ToolCallAccumulator,
  toolProgressTracker: HermesToolProgressTracker,
): Generator<HermesStreamEvent> {
  const frame = parseSseFrame(rawEvent)
  if (!frame.dataPayload) {
    return
  }

  const payload = frame.dataPayload
  if (payload === '[DONE]') {
    yield { type: 'done' }
    return
  }

  if (frame.eventType === 'hermes.tool.progress') {
    const progress = JSON.parse(payload) as HermesToolProgressPayload
    for (const toolEvent of toolProgressTracker.ingest(progress)) {
      yield toolEvent
    }
    return
  }

  const parsed = JSON.parse(payload) as OpenAiChatChunk
  for (const choice of parsed.choices ?? []) {
    const delta = choice.delta
    if (!delta) {
      continue
    }

    if (delta.reasoning_content) {
      yield { type: 'reasoning', text: delta.reasoning_content }
    }

    if (delta.content !== undefined) {
      yield* parseContentDelta(delta.content)
    }

    for (const toolEvent of toolCallAccumulator.ingest(delta.tool_calls ?? [])) {
      yield toolEvent
    }
  }
}

function* parseContentDelta(
  content: string | Array<{ type?: string; text?: string }>,
): Generator<HermesStreamEvent> {
  if (typeof content === 'string') {
    if (content) {
      yield { type: 'answer_token', text: content }
    }
    return
  }

  if (!Array.isArray(content)) {
    return
  }

  for (const part of content) {
    if (part.type === 'reasoning' && typeof part.text === 'string' && part.text) {
      yield { type: 'reasoning', text: part.text }
    } else if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      yield { type: 'answer_token', text: part.text }
    }
  }
}

function extractCompletionText(
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string {
  if (typeof content === 'string') {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim()
}

function parseSseFrame(rawEvent: string): { eventType?: string; dataPayload?: string } {
  const lines = rawEvent.split(/\r?\n/).map((line) => line.trimEnd())
  let eventType: string | undefined
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  return {
    eventType,
    dataPayload: dataLines.length > 0 ? dataLines.join('\n') : undefined,
  }
}

function extractSseFrame(buffer: string): { frame: string; rest: string } | null {
  const match = /\r?\n\r?\n/.exec(buffer)
  if (!match || match.index === undefined) {
    return null
  }

  const boundaryIndex = match.index
  const boundaryLength = match[0].length

  return {
    frame: buffer.slice(0, boundaryIndex),
    rest: buffer.slice(boundaryIndex + boundaryLength),
  }
}