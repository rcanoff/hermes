import { describe, expect, it, vi } from 'vitest'
import { StreamHub } from '../src/streams/hub.js'

describe('StreamHub user fan-out', () => {
  it('publishToUser delivers to every registered session for the user', () => {
    const hub = new StreamHub()
    const a = vi.fn()
    const b = vi.fn()

    hub.subscribeSession('sess-a', a)
    hub.subscribeSession('sess-b', b)
    hub.registerUserSession('user-1', 'sess-a')
    hub.registerUserSession('user-1', 'sess-b')

    hub.publishToUser('user-1', {
      event: 'reply',
      data: { conversationId: 'c1', runId: 'r1', text: 'hi' },
    })

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unregisterUserSession stops delivery to that session', () => {
    const hub = new StreamHub()
    const a = vi.fn()
    const b = vi.fn()

    hub.subscribeSession('sess-a', a)
    hub.subscribeSession('sess-b', b)
    hub.registerUserSession('user-1', 'sess-a')
    hub.registerUserSession('user-1', 'sess-b')
    hub.unregisterUserSession('sess-b')

    hub.publishToUser('user-1', {
      event: 'tooling',
      data: { conversationId: 'c1', runId: 'r1', phase: 'complete' },
    })

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('does not deliver to a different user', () => {
    const hub = new StreamHub()
    const listener = vi.fn()
    hub.subscribeSession('sess-a', listener)
    hub.registerUserSession('user-1', 'sess-a')

    hub.publishToUser('user-2', {
      event: 'error',
      data: { conversationId: 'c1', runId: 'r1', code: 'failed' },
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it('hasUserSessionListener is true when any session is connected', () => {
    const hub = new StreamHub()
    hub.subscribeSession('sess-a', () => {})
    hub.registerUserSession('user-1', 'sess-a')
    expect(hub.hasUserSessionListener('user-1')).toBe(true)
    hub.unregisterUserSession('sess-a')
    expect(hub.hasUserSessionListener('user-1')).toBe(false)
  })

  it('a user stream whose listener threw still unregisters its session when it closes', () => {
    const hub = new StreamHub()
    const unsubscribe = hub.connectUserSession('user-1', 'sess-a', () => { throw new Error('write failed') }, () => {})
    hub.publishToUser('user-1', { event: 'conversation_deleted', data: { conversationId: 'c1' } })
    expect(hub.hasSessionListener('sess-a')).toBe(false)

    unsubscribe()

    expect(hub.countUserSessions('user-1')).toBe(0)
  })

  it('a replaced user stream still unregisters its session when it closes', () => {
    const hub = new StreamHub()
    const unsubscribe = hub.connectUserSession('user-1', 'sess-a', vi.fn(), () => {})
    const stopReplacement = hub.replaceSessionConnection('sess-a', vi.fn())

    unsubscribe()

    expect(hub.countUserSessions('user-1')).toBe(0)
    expect(hub.hasSessionListener('sess-a')).toBe(true)
    stopReplacement()
  })

  it('the older stream of a reconnected session leaves the newer one registered', () => {
    const hub = new StreamHub()
    const older = hub.connectUserSession('user-1', 'sess-a', vi.fn(), () => {})
    const newer = hub.connectUserSession('user-1', 'sess-a', vi.fn(), () => {})

    older()
    expect(hub.countUserSessions('user-1')).toBe(1)
    newer()
    expect(hub.countUserSessions('user-1')).toBe(0)
  })
})