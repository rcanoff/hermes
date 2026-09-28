import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PresenceClock } from '../src/streams/presence.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

type Seeded = { id: string; username: string; token: string }
type PresenceData = { user_id: string; online: boolean; last_seen_at: string | null }
type ListedUser = { id: string; username: string; online: boolean; last_seen_at: string | null }

const START = Date.parse('2026-09-28T10:00:00.000Z')

describe('presence', () => {
  let app: FastifyInstance | undefined
  let clock: ManualClock
  let port: number
  let alice: Seeded
  let bob: Seeded
  let carol: Seeded
  const streams: SseStream[] = []

  beforeEach(async () => {
    clock = new ManualClock(START)
    app = await createTestApp({ presenceClock: clock })
    await app.ready()
    alice = await seedTestUser(app, 'alice', 'password123')
    bob = await seedTestUser(app, 'bob', 'password123')
    carol = await seedTestUser(app, 'carol', 'password123')
    await app.listen({ host: '127.0.0.1', port: 0 })
    port = (app.server.address() as AddressInfo).port
  })

  afterEach(async () => {
    await Promise.all(streams.map((stream) => stream.close()))
    streams.length = 0
    app?.server.closeAllConnections()
    await app?.close()
    app = undefined
  })

  it('connected_user_is_online_in_users_list', async () => {
    await connect(alice)

    const listed = await listUsers(bob)

    expect(listed.alice).toMatchObject({
      id: alice.id,
      username: 'alice',
      online: true,
      last_seen_at: new Date(START).toISOString(),
    })
    expect(listed.carol).toMatchObject({ online: false, last_seen_at: null })
  })

  it('second_session_keeps_user_online', async () => {
    const watcher = await connect(bob)
    const first = await connect(alice)
    await connect(alice, await app!.jwt.sign({ sub: alice.id, username: 'alice', jti: randomUUID() }))
    await first.close()
    await waitFor(() => app!.streamHub.countUserSessions(alice.id) === 1)

    clock.advance(5_000)
    await sentinel(watcher)

    expect(watcher.presence().filter((event) => event.user_id === alice.id)).toEqual([
      { user_id: alice.id, online: true, last_seen_at: new Date(START).toISOString() },
    ])
    expect((await listUsers(bob)).alice).toMatchObject({ online: true })
  })

  it('last_disconnect_goes_offline_after_debounce_with_last_seen', async () => {
    const watcher = await connect(bob)
    const stream = await connect(alice)
    clock.advance(30_000)
    await stream.close()
    await waitFor(() => app!.streamHub.countUserSessions(alice.id) === 0)

    clock.advance(4_999)
    expect((await listUsers(bob)).alice).toMatchObject({ online: true })

    clock.advance(1)
    const offlineAt = new Date(START + 35_000).toISOString()
    await waitFor(() => watcher.presence().some((event) => !event.online))

    expect(watcher.presence()).toEqual([
      { user_id: alice.id, online: true, last_seen_at: new Date(START).toISOString() },
      { user_id: alice.id, online: false, last_seen_at: offlineAt },
    ])
    expect((await listUsers(bob)).alice).toMatchObject({ online: false, last_seen_at: offlineAt })
  })

  it('reconnect_within_debounce_emits_nothing', async () => {
    const watcher = await connect(bob)
    const first = await connect(alice)
    await first.close()
    await waitFor(() => app!.streamHub.countUserSessions(alice.id) === 0)
    clock.advance(2_000)
    const second = await connect(alice)
    clock.advance(2_000)
    await second.close()
    await waitFor(() => app!.streamHub.countUserSessions(alice.id) === 0)

    // The debounce restarts at the second close: the first close's timer must not fire.
    clock.advance(4_999)
    expect((await listUsers(bob)).alice).toMatchObject({ online: true })
    clock.advance(1)
    await waitFor(() => watcher.presence().some((event) => !event.online))

    expect(watcher.presence()).toEqual([
      { user_id: alice.id, online: true, last_seen_at: new Date(START).toISOString() },
      { user_id: alice.id, online: false, last_seen_at: new Date(START + 9_000).toISOString() },
    ])
  })

  it('same_session_reconnect_keeps_user_online', async () => {
    const watcher = await connect(bob)
    const first = await connect(alice)
    // The phone reopens its stream with the same token while the old one is still open; the server ends the old one.
    const response = await fetch(`http://127.0.0.1:${port}/events/stream?include_shared=true`, {
      headers: { authorization: `Bearer ${alice.token}` },
    })
    streams.push(new SseStream(response.body!.getReader()))
    await first.ended()

    clock.advance(5_000)
    await sentinel(watcher)

    expect(watcher.presence().filter((event) => event.user_id === alice.id)).toEqual([
      { user_id: alice.id, online: true, last_seen_at: new Date(START).toISOString() },
    ])
    expect((await listUsers(bob)).alice).toMatchObject({ online: true })
  })

  it('closed_tracker_schedules_nothing', async () => {
    const stream = await connect(alice)
    app!.presence.close()
    await stream.close()
    await waitFor(() => app!.streamHub.countUserSessions(alice.id) === 0)

    expect(clock.pendingTimers()).toBe(0)
  })

  it('presence_is_broadcast_to_others_not_self', async () => {
    const watcher = await connect(bob)
    const self = await connect(alice)
    await waitFor(() => watcher.presence().some((event) => event.user_id === alice.id))

    await sentinel(self)

    expect(self.presence().map((event) => event.user_id)).toEqual([carol.id])
  })

  it('presence_passes_without_include_shared', async () => {
    const watcher = await connect(bob, bob.token, '')
    await connect(alice)

    await waitFor(() => watcher.presence().length > 0)

    expect(watcher.presence()).toEqual([
      { user_id: alice.id, online: true, last_seen_at: new Date(START).toISOString() },
    ])
  })

  it('fresh_process_has_nobody_online', async () => {
    app!.db
      .prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`)
      .run('2026-09-27T08:00:00.000Z', alice.id)

    const listed = await listUsers(bob)

    expect(listed.alice).toMatchObject({ online: false, last_seen_at: '2026-09-27T08:00:00.000Z' })
    expect(listed.carol).toMatchObject({ online: false, last_seen_at: null })
  })

  it('stale_stream_without_heartbeat_goes_offline', async () => {
    const watcher = await connect(bob)
    const stream = await connect(alice)
    clock.advance(30_000)
    await heartbeat(bob)

    clock.advance(15_000)
    await stream.ended()
    expect(app!.streamHub.countUserSessions(alice.id)).toBe(0)
    expect((await listUsers(bob)).alice).toMatchObject({ online: true })

    clock.advance(5_000)
    const offlineAt = new Date(START + 50_000).toISOString()
    await waitFor(() => watcher.presence().some((event) => !event.online))

    expect(watcher.presence()).toEqual([
      { user_id: alice.id, online: true, last_seen_at: new Date(START).toISOString() },
      { user_id: alice.id, online: false, last_seen_at: offlineAt },
    ])
    expect((await listUsers(bob)).alice).toMatchObject({ online: false, last_seen_at: offlineAt })
  })

  it('heartbeat_keeps_stream_alive', async () => {
    const watcher = await connect(bob)
    await connect(alice)
    clock.advance(30_000)
    await heartbeat(bob)
    await heartbeat(alice)

    clock.advance(30_000)
    await sentinel(watcher)

    expect(app!.streamHub.countUserSessionsWithListeners(alice.id)).toBe(1)
    expect(watcher.presence().filter((event) => event.user_id === alice.id)).toEqual([
      { user_id: alice.id, online: true, last_seen_at: new Date(START).toISOString() },
    ])
    expect((await listUsers(bob)).alice).toMatchObject({ online: true })
  })

  it('fresh_connection_counts_as_heartbeat', async () => {
    const first = await connect(alice)
    clock.advance(30_000)
    // Same token: the reconnect replaces the first stream within the same session.
    const response = await fetch(`http://127.0.0.1:${port}/events/stream?include_shared=true`, {
      headers: { authorization: `Bearer ${alice.token}` },
    })
    const second = new SseStream(response.body!.getReader())
    streams.push(second)
    await first.ended()

    clock.advance(30_000)
    expect(app!.streamHub.countUserSessionsWithListeners(alice.id)).toBe(1)

    clock.advance(15_000)
    await second.ended()
    expect(app!.streamHub.countUserSessions(alice.id)).toBe(0)
  })

  async function connect(user: Seeded, token = user.token, query = '?include_shared=true') {
    const before = app!.streamHub.countUserSessionsWithListeners(user.id)
    const response = await fetch(`http://127.0.0.1:${port}/events/stream${query}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const stream = new SseStream(response.body!.getReader())
    streams.push(stream)
    await waitFor(() => app!.streamHub.countUserSessionsWithListeners(user.id) > before)
    return stream
  }

  /** Carol connects; once `stream` sees her, every earlier event has been delivered. */
  async function sentinel(stream: SseStream): Promise<void> {
    await connect(carol)
    await waitFor(() => stream.presence().some((event) => event.user_id === carol.id))
  }

  async function listUsers(caller: Seeded): Promise<Record<string, ListedUser>> {
    const response = await app!.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${caller.token}` },
    })
    expect(response.statusCode).toBe(200)
    const users = (response.json() as { users: ListedUser[] }).users
    return Object.fromEntries(users.map((user) => [user.username, user]))
  }

  async function heartbeat(user: Seeded): Promise<void> {
    const response = await app!.inject({
      method: 'POST',
      url: '/events/heartbeat',
      headers: { authorization: `Bearer ${user.token}` },
    })
    expect(response.statusCode).toBe(204)
  }
})

class ManualClock implements PresenceClock {
  private current: number
  private nextId = 0
  private timers: Array<{ id: number; at: number; callback: () => void }> = []

  constructor(start: number) {
    this.current = start
  }

  now(): Date {
    return new Date(this.current)
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.nextId
    this.timers.push({ id, at: this.current + ms, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle)
  }

  /** Fires due timers in time order, each at its own due time, so re-armed timers fire again within one advance. */
  advance(ms: number): void {
    const target = this.current + ms
    while (true) {
      const next = this.timers
        .filter((timer) => timer.at <= target)
        .reduce<(typeof this.timers)[number] | undefined>(
          (earliest, timer) => (earliest === undefined || timer.at < earliest.at ? timer : earliest),
          undefined,
        )
      if (next === undefined) break
      this.timers = this.timers.filter((timer) => timer.id !== next.id)
      this.current = next.at
      next.callback()
    }
    this.current = target
  }

  pendingTimers(): number {
    return this.timers.length
  }
}

class SseStream {
  private text = ''
  private readonly done: Promise<void>

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.done = this.pump()
  }

  presence(): PresenceData[] {
    return this.text
      .split('\n\n')
      .filter((block) => block.startsWith('event: presence\n'))
      .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 6)) as PresenceData)
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined)
    await this.done
  }

  /** Resolves when the server ends the stream. */
  ended(): Promise<void> {
    return this.done
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder()
    while (true) {
      const { value, done } = await this.reader.read().catch(() => ({ value: undefined, done: true }))
      if (value) this.text += decoder.decode(value, { stream: true })
      if (done) return
    }
  }
}

/** Polls for socket-level effects (SSE connect/disconnect) the server exposes no signal for. */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}
