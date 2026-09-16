import { describe, expect, it, vi } from 'vitest'
import { StreamHub, type SessionStreamEvent } from '../../src/streams/hub.js'

const event: SessionStreamEvent = {
  event: 'title',
  data: { conversationId: 'c1', title: 'Demo' },
}

describe('StreamHub session ownership', () => {
  it('keeps B registered after A reconnects and A cleanup runs', () => {
    const hub = new StreamHub()
    const a: SessionStreamEvent[] = []
    const b: SessionStreamEvent[] = []
    const closeA = vi.fn()
    const closeB = vi.fn()

    const cleanupA = hub.connectUserSession('user-1', 'sess', (item) => a.push(item), closeA)
    const cleanupB = hub.connectUserSession('user-1', 'sess', (item) => b.push(item), closeB)

    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).not.toHaveBeenCalled()

    cleanupA()
    hub.publishToUser('user-1', event)

    expect(a).toHaveLength(0)
    expect(b).toEqual([event])
    expect(hub.hasUserSessionListener('user-1')).toBe(true)

    cleanupB()
  })

  it('does not close B when replacing A, and repeated A cleanup is a no-op', () => {
    const hub = new StreamHub()
    const b: SessionStreamEvent[] = []
    const closeA = vi.fn()
    const closeB = vi.fn()

    const cleanupA = hub.connectUserSession('user-1', 'sess', () => {}, closeA)
    hub.connectUserSession('user-1', 'sess', (item) => b.push(item), closeB)

    cleanupA()
    cleanupA()
    hub.publishToUser('user-1', event)

    expect(closeB).not.toHaveBeenCalled()
    expect(b).toEqual([event])
  })

  it('fan-out still reaches a second session after one reconnects', () => {
    const hub = new StreamHub()
    const first: SessionStreamEvent[] = []
    const second: SessionStreamEvent[] = []

    hub.connectUserSession('user-1', 'sess-a', (item) => first.push(item), () => {})
    hub.connectUserSession('user-1', 'sess-b', (item) => second.push(item), () => {})
    hub.connectUserSession('user-1', 'sess-a', (item) => first.push(item), () => {})

    hub.publishToUser('user-1', event)
    expect(first).toEqual([event])
    expect(second).toEqual([event])
  })

  it('does not drop a newer listener when an obsolete one throws', () => {
    const hub = new StreamHub()
    const newer: SessionStreamEvent[] = []

    hub.connectUserSession(
      'user-1',
      'sess',
      () => {
        throw new Error('obsolete')
      },
      () => {},
    )
    hub.connectUserSession('user-1', 'sess', (item) => newer.push(item), () => {})

    hub.publishToUser('user-1', event)
    expect(newer).toEqual([event])

    hub.publishToUser('user-1', event)
    expect(newer).toHaveLength(2)
  })

  it('unregisters the user when the final owner disconnects', () => {
    const hub = new StreamHub()
    const cleanup = hub.connectUserSession('user-1', 'sess', () => {}, () => {})
    expect(hub.hasUserSessionListener('user-1')).toBe(true)
    cleanup()
    expect(hub.hasUserSessionListener('user-1')).toBe(false)
  })
})
