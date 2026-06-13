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

  it('ignores duplicate hermes.tool.progress completed frames', () => {
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

    expect(running).toHaveLength(1)
    expect(completed).toEqual([])
  })
})