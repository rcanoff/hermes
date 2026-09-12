import type { MessageInput } from '../db/repos/messages.js'

export const GROK_PROMPT_TIMEOUT_MS = 1_800_000
export const GROK_REQUEST_TIMEOUT_MS = 15_000
export const GROK_PROMPT_IN_FLIGHT_RETRY_MS = 200

export type GrokGatewayEvent =
  | {
      type: 'tooling'
      phase: 'reasoning' | 'activity' | 'status'
      text: string
      tool?: string | null
      args?: Record<string, unknown> | null
    }
  | { type: 'token'; text: string }
  | { type: 'pending_input'; content: string; input: MessageInput }
  | { type: 'done' }
  | { type: 'error'; error: string; code?: string }

export type GrokTurnStartEvent = { type: 'turn_start'; user_id: string; text: string }

export type GrokOutboxEvent = GrokGatewayEvent | GrokTurnStartEvent

export interface GrokOutboxItem {
  seq: number
  ts: string
  event: GrokOutboxEvent
}

export interface GrokOutboxSnapshot {
  events: GrokOutboxItem[]
  last_seq: number
  prompt_in_flight: boolean
}

export type GrokInputAction = 'allow' | 'deny' | 'reply'

export type GrokGatewayErrorCode =
  | 'grok_unavailable'
  | 'not_pending'
  | 'invalid_action'
  | 'not_found'
  | 'prompt_in_flight'

export class GrokGatewayError extends Error {
  constructor(
    readonly code: GrokGatewayErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'GrokGatewayError'
  }
}

export interface GrokGatewayModel {
  id: string
  display: string
  default?: boolean
}

export interface GrokModelsResponse {
  models: GrokGatewayModel[]
  default: string
}

export interface GrokPutSessionBody {
  soul: string
  cwd?: string
  model?: string
}

export interface GrokGatewayClient {
  health(): Promise<{ ok: true; grok: 'up' | 'down' }>
  listModels(): Promise<GrokModelsResponse>
  putSession(conversationId: string, body: GrokPutSessionBody): Promise<void>
  patchSessionModel(conversationId: string, model: string): Promise<void>
  prompt(
    conversationId: string,
    body: { text: string; user_id: string },
    signal?: AbortSignal,
  ): AsyncIterable<GrokGatewayEvent>
  resolveInput(
    conversationId: string,
    body: { input_id: string; action: GrokInputAction; text?: string },
  ): Promise<void>
  cancelPrompt(conversationId: string): Promise<void>
  deleteSession(conversationId: string): Promise<void>
  fetchOutbox(conversationId: string, afterSeq?: number): Promise<GrokOutboxSnapshot>
  ackOutbox(conversationId: string, through: number): Promise<void>
}

export function createGrokGatewayClient(url: string, token: string): GrokGatewayClient {
  const trimmed = url.trim()
  if (!trimmed) {
    return new DisabledGrokGatewayClient()
  }
  return new HttpGrokGatewayClient(trimmed.replace(/\/+$/, ''), token)
}

export class DisabledGrokGatewayClient implements GrokGatewayClient {
  async health(): Promise<{ ok: true; grok: 'down' }> {
    return { ok: true, grok: 'down' }
  }

  async listModels(): Promise<GrokModelsResponse> {
    throw new GrokGatewayError('grok_unavailable')
  }

  async putSession(): Promise<void> {
    throw new GrokGatewayError('grok_unavailable')
  }

  async patchSessionModel(): Promise<void> {
    throw new GrokGatewayError('grok_unavailable')
  }

  async *prompt(
    _conversationId: string,
    _body: { text: string; user_id: string },
    _signal?: AbortSignal,
  ): AsyncIterable<GrokGatewayEvent> {
    throw new GrokGatewayError('grok_unavailable')
  }

  async resolveInput(): Promise<void> {
    throw new GrokGatewayError('grok_unavailable')
  }

  async cancelPrompt(): Promise<void> {}

  async deleteSession(): Promise<void> {}

  async fetchOutbox(_conversationId: string, afterSeq = 0): Promise<GrokOutboxSnapshot> {
    return { events: [], last_seq: afterSeq, prompt_in_flight: false }
  }

  async ackOutbox(): Promise<void> {}
}

export class HttpGrokGatewayClient implements GrokGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async health(): Promise<{ ok: true; grok: 'up' | 'down' }> {
    const response = await this.request('/health', { method: 'GET' }, GROK_REQUEST_TIMEOUT_MS)
    const body = (await response.json()) as { ok?: unknown; grok?: unknown }
    const grok = body.grok === 'up' ? 'up' : 'down'
    return { ok: true, grok }
  }

  async listModels(): Promise<GrokModelsResponse> {
    const response = await this.request('/models', { method: 'GET' }, GROK_REQUEST_TIMEOUT_MS)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new GrokGatewayError('grok_unavailable', 'invalid_models')
    }
    return parseGrokModelsResponse(body)
  }

  async putSession(conversationId: string, body: GrokPutSessionBody): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(conversationId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
      GROK_REQUEST_TIMEOUT_MS,
    )
  }

  async patchSessionModel(conversationId: string, model: string): Promise<void> {
    try {
      await this.request(
        `/sessions/${encodeURIComponent(conversationId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ model }),
        },
        GROK_REQUEST_TIMEOUT_MS,
      )
    } catch (error) {
      if (error instanceof GrokGatewayError && error.code === 'not_found') {
        return
      }
      throw error
    }
  }

  async *prompt(
    conversationId: string,
    body: { text: string; user_id: string },
    signal?: AbortSignal,
  ): AsyncIterable<GrokGatewayEvent> {
    const response = await this.request(
      `/sessions/${encodeURIComponent(conversationId)}/prompt`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      GROK_PROMPT_TIMEOUT_MS,
      signal,
    )
    if (!response.body) {
      throw new GrokGatewayError('grok_unavailable')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const event = parseGatewayEvent(line)
        if (event) {
          yield event
        }
        newline = buffer.indexOf('\n')
      }
    }

    const tail = parseGatewayEvent(buffer.trim())
    if (tail) {
      yield tail
    }
  }

  async resolveInput(
    conversationId: string,
    body: { input_id: string; action: GrokInputAction; text?: string },
  ): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(conversationId)}/input`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      GROK_REQUEST_TIMEOUT_MS,
    )
  }

  async cancelPrompt(conversationId: string): Promise<void> {
    try {
      await this.request(
        `/sessions/${encodeURIComponent(conversationId)}/cancel`,
        { method: 'POST' },
        GROK_REQUEST_TIMEOUT_MS,
      )
    } catch (error) {
      if (error instanceof GrokGatewayError && error.code === 'not_found') {
        return
      }
      throw error
    }
  }

  async deleteSession(conversationId: string): Promise<void> {
    try {
      await this.request(
        `/sessions/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' },
        GROK_REQUEST_TIMEOUT_MS,
      )
    } catch (error) {
      if (error instanceof GrokGatewayError && error.code === 'not_found') {
        return
      }
      throw error
    }
  }

  async fetchOutbox(conversationId: string, afterSeq = 0): Promise<GrokOutboxSnapshot> {
    const after = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.floor(afterSeq) : 0
    const response = await this.request(
      `/sessions/${encodeURIComponent(conversationId)}/outbox?after=${encodeURIComponent(String(after))}`,
      { method: 'GET' },
      GROK_REQUEST_TIMEOUT_MS,
    )
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new GrokGatewayError('grok_unavailable', 'invalid_outbox')
    }
    return parseOutboxSnapshot(body)
  }

  async ackOutbox(conversationId: string, through: number): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(conversationId)}/outbox/ack`,
      {
        method: 'POST',
        body: JSON.stringify({ through }),
      },
      GROK_REQUEST_TIMEOUT_MS,
    )
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      })
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        const abortError = new Error('aborted')
        abortError.name = 'AbortError'
        throw abortError
      }
      throw new GrokGatewayError('grok_unavailable')
    }

    if (response.ok || response.status === 204) {
      return response
    }

    throw await this.errorFrom(response)
  }

  private async errorFrom(response: Response): Promise<GrokGatewayError> {
    let code: GrokGatewayErrorCode = 'grok_unavailable'
    let message: string | undefined
    try {
      const body = (await response.json()) as { error?: unknown }
      if (
        body.error === 'not_pending' ||
        body.error === 'invalid_action' ||
        body.error === 'not_found' ||
        body.error === 'prompt_in_flight'
      ) {
        code = body.error
      }
      if (typeof body.error === 'string') {
        message = body.error
      }
    } catch {
      // Non-JSON error bodies still map to grok_unavailable unless status is 404.
    }
    if (response.status === 404) {
      code = 'not_found'
    }
    return new GrokGatewayError(code, message)
  }
}

function parseGrokModelsResponse(value: unknown): GrokModelsResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GrokGatewayError('grok_unavailable', 'invalid_models')
  }

  const body = value as Record<string, unknown>
  if (!Array.isArray(body.models)) {
    throw new GrokGatewayError('grok_unavailable', 'invalid_models')
  }

  const models: GrokGatewayModel[] = []
  for (const item of body.models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      continue
    }
    if (typeof entry.display !== 'string' || !entry.display.trim()) {
      continue
    }
    models.push({
      id: entry.id,
      display: entry.display,
      ...(entry.default === true ? { default: true } : {}),
    })
  }

  const defaultId =
    (typeof body.default === 'string' && body.default.trim()) ||
    models.find((entry) => entry.default)?.id ||
    models[0]?.id
  if (!defaultId || models.length === 0) {
    throw new GrokGatewayError('grok_unavailable', 'invalid_models')
  }

  return { models, default: defaultId }
}

function parseOutboxSnapshot(value: unknown): GrokOutboxSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GrokGatewayError('grok_unavailable', 'invalid_outbox')
  }

  const body = value as Record<string, unknown>
  if (
    !Array.isArray(body.events) ||
    typeof body.last_seq !== 'number' ||
    !Number.isFinite(body.last_seq) ||
    typeof body.prompt_in_flight !== 'boolean'
  ) {
    throw new GrokGatewayError('grok_unavailable', 'invalid_outbox')
  }

  const events: GrokOutboxItem[] = []
  for (const item of body.events) {
    const parsed = parseOutboxItem(item)
    if (parsed) {
      events.push(parsed)
    }
  }

  return {
    events,
    last_seq: body.last_seq,
    prompt_in_flight: body.prompt_in_flight,
  }
}

function parseOutboxItem(value: unknown): GrokOutboxItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const item = value as Record<string, unknown>
  if (typeof item.seq !== 'number' || !Number.isFinite(item.seq) || typeof item.ts !== 'string') {
    return null
  }

  const event = parseOutboxEvent(item.event)
  if (!event) {
    return null
  }

  return { seq: item.seq, ts: item.ts, event }
}

function parseOutboxEvent(value: unknown): GrokOutboxEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const event = value as Record<string, unknown>
  if (event.type === 'turn_start' && typeof event.user_id === 'string' && typeof event.text === 'string') {
    return { type: 'turn_start', user_id: event.user_id, text: event.text }
  }

  return parseGatewayEventValue(event)
}

function parseGatewayEvent(line: string): GrokGatewayEvent | null {
  if (!line) {
    return null
  }

  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  return parseGatewayEventValue(value)
}

function parseGatewayEventValue(value: unknown): GrokGatewayEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const event = value as Record<string, unknown>
  if (event.type === 'token' && typeof event.text === 'string') {
    return { type: 'token', text: event.text }
  }
  if (event.type === 'done') {
    return { type: 'done' }
  }
  if (event.type === 'error' && typeof event.error === 'string') {
    return {
      type: 'error',
      error: event.error,
      ...(typeof event.code === 'string' ? { code: event.code } : {}),
    }
  }
  if (
    event.type === 'tooling' &&
    (event.phase === 'reasoning' || event.phase === 'activity' || event.phase === 'status') &&
    typeof event.text === 'string'
  ) {
    return {
      type: 'tooling',
      phase: event.phase,
      text: event.text,
      ...(event.tool === undefined || event.tool === null || typeof event.tool === 'string'
        ? { tool: (event.tool as string | null | undefined) ?? null }
        : {}),
      ...(event.args && typeof event.args === 'object' && !Array.isArray(event.args)
        ? { args: event.args as Record<string, unknown> }
        : {}),
    }
  }
  if (event.type === 'pending_input' && typeof event.content === 'string' && isPendingInput(event.input)) {
    return { type: 'pending_input', content: event.content, input: event.input }
  }
  return null
}

function isPendingInput(value: unknown): value is MessageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const input = value as Record<string, unknown>
  return (
    typeof input.id === 'string' &&
    input.id.length > 0 &&
    (input.type === 'permission' || input.type === 'question') &&
    (input.status === 'pending' ||
      input.status === 'allowed' ||
      input.status === 'denied' ||
      input.status === 'answered' ||
      input.status === 'cancelled')
  )
}
