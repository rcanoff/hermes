import type { HermesPromptMessage } from './prompt-builder.js'

export interface StreamChatInput {
  hermesSessionId: string
  messages: HermesPromptMessage[]
}

export interface HermesStreamEvent {
  type: 'token' | 'tool' | 'done'
  text?: string
  name?: string
}

export interface HermesClient {
  streamChat(input: StreamChatInput): AsyncIterable<HermesStreamEvent>
}

interface OpenAiChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>
      tool_calls?: Array<{
        function?: {
          name?: string
        }
      }>
    }
  }>
}

export class OpenAiHermesClient implements HermesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey = '',
  ) {}

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

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })

      while (true) {
        const extraction = extractSseFrame(buffer)
        if (!extraction) {
          break
        }

        buffer = extraction.rest

        for (const event of parseSseEvent(extraction.frame)) {
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

function* parseSseEvent(rawEvent: string): Generator<HermesStreamEvent> {
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
    const content = normalizeContent(choice.delta?.content)
    if (content) {
      yield { type: 'token', text: content }
    }

    for (const toolCall of choice.delta?.tool_calls ?? []) {
      const name = toolCall.function?.name
      if (name) {
        yield { type: 'tool', name }
      }
    }
  }
}

function normalizeContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
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
