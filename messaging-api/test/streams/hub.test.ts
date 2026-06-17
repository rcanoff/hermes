import { describe, expect, it } from 'vitest'
import { StreamHub, type SessionStreamEvent } from '../../src/streams/hub.js'

describe('StreamHub session listeners', () => {
  it('publishes session events only to the matching session', () => {
    const hub = new StreamHub()
    const a: SessionStreamEvent[] = []
    const b: SessionStreamEvent[] = []
    hub.subscribeSession('sess-a', (event) => a.push(event))
    hub.subscribeSession('sess-b', (event) => b.push(event))

    hub.publishSession('sess-a', {
      event: 'reply',
      data: { conversationId: 'c1', runId: 'r1', text: 'hi' },
    })

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
  })

  it('replaces the previous session connection on reconnect', () => {
    const hub = new StreamHub()
    const first: SessionStreamEvent[] = []
    const second: SessionStreamEvent[] = []

    hub.replaceSessionConnection('sess-a', (event) => first.push(event))
    hub.replaceSessionConnection('sess-a', (event) => second.push(event))

    hub.publishSession('sess-a', {
      event: 'title',
      data: { conversationId: 'c1', title: 'Demo' },
    })

    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })
})