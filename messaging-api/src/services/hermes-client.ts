import type { HermesPromptMessage } from './prompt-builder.js'

export interface StreamChatInput {
  hermesSessionId: string
  messages: HermesPromptMessage[]
}

export interface CompleteChatInput {
  hermesSessionId: string
  messages: HermesPromptMessage[]
}

export interface HermesStreamEvent {
  type: 'reasoning' | 'tool' | 'answer_token' | 'done'
  text?: string
  name?: string
  arguments?: string
}

export interface HermesClient {
  streamChat(input: StreamChatInput): AsyncIterable<HermesStreamEvent>
  completeChat(input: CompleteChatInput): Promise<string>
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
  ) {}

  async completeChat(input: CompleteChatInput): Promise<string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-hermes-session-id': input.hermesSessionId,
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

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })

      while (true) {
        const extraction = extractSseFrame(buffer)
        if (!extraction) {
          break
        }

        buffer = extraction.rest

        for (const event of parseSseEvent(extraction.frame, toolCallAccumulator)) {
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
): HermesStreamEvent[] {
  return [...parseSseEvent(rawEvent, accumulator)]
}

function* parseSseEvent(
  rawEvent: string,
  toolCallAccumulator: ToolCallAccumulator,
): Generator<HermesStreamEvent> {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())

  if (dataLines.length === 0) {
    return
  }

  const payload = dataLines.join('\n')
  if (payload === '[DONE]') {
    yield { type: 'done' }
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