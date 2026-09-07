import { describe, expect, it } from 'vitest'
import {
  HermesToolProgressTracker,
  parseHermesSsePayload,
  ToolCallAccumulator,
} from '../src/services/hermes-client.js'

describe('parseHermesSsePayload', () => {
  it('emits reasoning events from reasoning_content deltas', () => {
    const events = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"reasoning_content":"Searching tools"}}]}\n\n',
    )
    expect(events).toEqual([{ type: 'reasoning', text: 'Searching tools' }])
  })

  it('emits a completed tool event when tool call args finish', () => {
    const accumulator = new ToolCallAccumulator()
    const first = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"skill_view","arguments":"{\\"na"}}]}}]}\n\n',
      accumulator,
    )
    const second = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"me\\":\\"demo\\"}"}}]}}]}\n\n',
      accumulator,
    )

    expect(first).toEqual([])
    expect(second).toEqual([{ type: 'tool', name: 'skill_view', arguments: '{"name":"demo"}' }])
  })

  it('emits answer_token only for final content text', () => {
    const events = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    )
    expect(events).toEqual([{ type: 'answer_token', text: 'Hello' }])
  })

  it('ignores reasoning content parts in content arrays', () => {
    const events = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"content":[{"type":"reasoning","text":"hidden"},{"type":"text","text":"Hi"}]}}]}\n\n',
    )
    expect(events).toEqual([
      { type: 'reasoning', text: 'hidden' },
      { type: 'answer_token', text: 'Hi' },
    ])
  })

  it('emits done for [DONE]', () => {
    expect(parseHermesSsePayload('data: [DONE]\n\n')).toEqual([{ type: 'done' }])
  })

  it('emits error for finish_reason error with Hermes error payload', () => {
    const events = parseHermesSsePayload(
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"error"}],"error":{"message":"No LLM provider configured. Run `hermes model` to select a provider, or run `hermes setup` for first-time configuration.","type":"RuntimeError"},"hermes":{"completed":true,"partial":false,"failed":true,"error":"No LLM provider configured. Run `hermes model` to select a provider, or run `hermes setup` for first-time configuration.","error_code":"agent_error"}}\n\n',
    )
    expect(events).toEqual([
      {
        type: 'error',
        text: 'No LLM provider configured. Run `hermes model` to select a provider, or run `hermes setup` for first-time configuration.',
      },
    ])
  })

  it('emits a generic error when finish_reason is error without a message', () => {
    expect(
      parseHermesSsePayload('data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n'),
    ).toEqual([{ type: 'error', text: 'Hermes stream failed' }])
  })

  it('emits tool events from hermes.tool.progress running frames', () => {
    const tracker = new HermesToolProgressTracker()
    const events = parseHermesSsePayload(
      'event: hermes.tool.progress\ndata: {"tool":"skill_view","label":"companion-user-location","toolCallId":"call_1","status":"running"}\n\n',
      new ToolCallAccumulator(),
      tracker,
    )

    expect(events).toEqual([
      { type: 'tool', name: 'skill_view', label: 'companion-user-location' },
    ])
  })

  it('emits tool_complete after hermes.tool.progress completed frames', () => {
    const tracker = new HermesToolProgressTracker()
    const running = parseHermesSsePayload(
      'event: hermes.tool.progress\ndata: {"tool":"skill_view","label":"demo","toolCallId":"call_1","status":"running"}\n\n',
      new ToolCallAccumulator(),
      tracker,
    )
    const completed = parseHermesSsePayload(
      'event: hermes.tool.progress\ndata: {"tool":"skill_view","toolCallId":"call_1","status":"completed"}\n\n',
      new ToolCallAccumulator(),
      tracker,
    )

    expect(running).toEqual([{ type: 'tool', name: 'skill_view', label: 'demo' }])
    expect(completed).toEqual([{ type: 'tool_complete', name: 'skill_view', label: 'demo' }])
  })
})