import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ensureDefaultBotRow, getBotBySlug, insertBot } from '../src/db/repos/bots.js'
import { createConversation } from '../src/db/repos/conversations.js'
import { insertMessage, listMessages } from '../src/db/repos/messages.js'
import { createRun } from '../src/db/repos/runs.js'
import { createInviteRecord } from '../src/services/invites.js'
import { createTestApp } from './helpers/app.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { seedTestUser } from './helpers/users.js'

async function createMcpClient(app: FastifyInstance, bearerToken: string) {
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    },
  })
  const client = new Client({ name: 'mcp-test-client', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport, address }
}

function parseToolResult(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((part) => part.type === 'text')?.text
  expect(text).toBeDefined()
  return JSON.parse(text!) as Record<string, unknown>
}

describe('companion MCP routes', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns 401 without bearer auth', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns unavailable location when vault is empty', async () => {
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')

    const result = await client.callTool({
      name: 'get_user_location',
      arguments: { username: 'operator' },
    })
    const payload = parseToolResult(result)

    expect(payload).toEqual({ available: false })

    await transport.close()
    await client.close()
  })

  it('returns latest location with freshness for a seeded user', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        lat: 38.7223,
        lon: -9.1393,
        accuracy_m: 12,
        timestamp: '2026-06-13T09:48:00.000Z',
        trigger: 'significant_change',
        source: 'ios',
        address: 'Rua D Fernando I 41, Fernão Ferro, Portugal',
      },
    })

    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'get_user_location',
      arguments: { username: 'operator' },
    })
    const payload = parseToolResult(result)

    expect(payload).toMatchObject({
      available: true,
      lat: 38.7223,
      lon: -9.1393,
      accuracy_m: 12,
      address: 'Rua D Fernando I 41, Fernão Ferro, Portugal',
      address_status: 'resolved',
      timestamp: '2026-06-13T09:48:00.000Z',
      trigger: 'significant_change',
      freshness: expect.any(String),
    })

    await transport.close()
    await client.close()
  })

  it('returns paginated location history', async () => {
    const timestamps = [
      '2026-06-13T09:00:00.000Z',
      '2026-06-13T10:00:00.000Z',
      '2026-06-13T11:00:00.000Z',
    ]

    const createdIds: string[] = []
    for (const [index, timestamp] of timestamps.entries()) {
      await app!.inject({
        method: 'POST',
        url: '/data/location/events',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          lat: 38 + index,
          lon: -9.1393,
          accuracy_m: 12,
          timestamp,
          trigger: 'manual',
          source: 'ios',
        },
      })

      const row = app!.db
        .prepare('SELECT id FROM location_events WHERE timestamp = ?')
        .get(timestamp) as { id: string }
      createdIds.push(row.id)
    }

    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')

    const firstPage = await client.callTool({
      name: 'get_location_history',
      arguments: { username: 'operator', limit: 2 },
    })
    const firstPayload = parseToolResult(firstPage) as {
      events: Array<{ id: string; timestamp: string }>
      _links: { self: { href: string }; next?: { href: string } }
    }

    expect(firstPayload.events).toHaveLength(2)
    expect(firstPayload.events[0]).toMatchObject({ id: createdIds[2], timestamp: timestamps[2] })
    expect(firstPayload.events[1]).toMatchObject({ id: createdIds[1], timestamp: timestamps[1] })
    expect(firstPayload._links.self.href).toBe('/data/location/events?limit=2')
    expect(firstPayload._links.next?.href).toBe(
      `/data/location/events?limit=2&before=${createdIds[1]}`,
    )

    const secondPage = await client.callTool({
      name: 'get_location_history',
      arguments: { username: 'operator', limit: 2, before: createdIds[1] },
    })
    const secondPayload = parseToolResult(secondPage) as {
      events: Array<{ id: string; timestamp: string }>
      _links: { prev?: { href: string } }
    }

    expect(secondPayload.events).toHaveLength(1)
    expect(secondPayload.events[0]).toMatchObject({ id: createdIds[0], timestamp: timestamps[0] })
    expect(secondPayload._links.prev?.href).toBe(
      `/data/location/events?limit=2&after=${createdIds[0]}`,
    )

    await transport.close()
    await client.close()
  })

  it('get_user_health_today returns available summary', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        date: '2026-06-17',
        timezone: 'Europe/Lisbon',
        partial: true,
        source: 'healthkit',
        metrics: {
          steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
        },
      },
    })

    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'get_user_health_today',
      arguments: { username: 'operator' },
    })
    const payload = parseToolResult(result)

    expect(payload).toMatchObject({
      available: true,
      username: 'operator',
      date: '2026-06-17',
      timezone: 'Europe/Lisbon',
      partial: true,
      metrics: {
        steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
      },
    })

    await transport.close()
    await client.close()
  })

  it('get_user_health_today passes through v2 metrics', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        date: '2026-06-18',
        timezone: 'Europe/Lisbon',
        partial: true,
        source: 'healthkit',
        metrics: {
          sleep_duration: { value: 420, unit: 'min', goal: null, remaining: null },
          workout_types: { types: ['running', 'walking'] },
        },
      },
    })

    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'get_user_health_today',
      arguments: { username: 'operator' },
    })
    const payload = parseToolResult(result) as {
      metrics: {
        sleep_duration: { value: number }
        workout_types: { types: string[] }
      }
    }

    expect(payload.metrics.sleep_duration.value).toBe(420)
    expect(payload.metrics.workout_types.types).toEqual(['running', 'walking'])

    await transport.close()
    await client.close()
  })

  it('get_user_health_daily returns unavailable for missing date', async () => {
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'get_user_health_daily',
      arguments: { username: 'operator', date: '2026-06-01' },
    })
    const payload = parseToolResult(result)

    expect(payload).toEqual({
      available: false,
      username: 'operator',
      date: '2026-06-01',
    })

    await transport.close()
    await client.close()
  })

  it('get_user_health_history returns HAL summaries', async () => {
    const dates = ['2026-06-15', '2026-06-16', '2026-06-17']

    for (const date of dates) {
      await app!.inject({
        method: 'POST',
        url: '/data/health/daily-summaries',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          date,
          timezone: 'Europe/Lisbon',
          partial: true,
          source: 'healthkit',
          metrics: {
            steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
          },
        },
      })
    }

    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'get_user_health_history',
      arguments: { username: 'operator', limit: 20 },
    })
    const payload = parseToolResult(result) as {
      summaries: Array<{ date: string }>
      _links: { self: { href: string } }
    }

    expect(payload.summaries).toHaveLength(3)
    expect(payload.summaries.map((summary) => summary.date)).toEqual([
      '2026-06-17',
      '2026-06-16',
      '2026-06-15',
    ])
    expect(payload._links.self.href).toBe('/data/health/daily-summaries?limit=20')

    await transport.close()
    await client.close()
  })

  it('creates an activation invite via MCP', async () => {
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'create_companion_invite',
      arguments: { label: 'Roberto' },
    })
    const payload = parseToolResult(result) as { invite_id: string; token: string; expires_at: string }
    expect(payload.token.length).toBeGreaterThan(30)
    expect(payload.invite_id).toBeTruthy()
    expect(payload.expires_at).toBeTruthy()
    await transport.close()
    await client.close()
  })

  it('lists users and pending invites', async () => {
    const { rawToken } = createInviteRecord(app!.db, { type: 'activation', expiryHours: 48 })
    void rawToken
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({ name: 'list_companion_accounts', arguments: {} })
    const payload = parseToolResult(result) as { pending_invites: unknown[]; users: unknown[] }
    expect(payload.pending_invites.length).toBe(1)
    await transport.close()
    await client.close()
  })

  it('returns a tool error for an unknown teammate', async () => {
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'message_teammate',
      arguments: { username: 'operator', name: 'Unknown', text: 'Help' },
    })

    expect(result.isError).toBe(true)
    const text = result.content.find((part) => part.type === 'text')?.text
    expect(text).toContain('Unknown teammate "Unknown"')

    await transport.close()
    await client.close()
  })

  it('messages a teammate through MCP during a default-bot turn', async () => {
    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('Pack sunscreen.')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()

    await app?.close()
    app = await createTestApp({ hermesClient })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    insertBot(app.db, {
      userId: seeded.id,
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'You book trips.',
    })
    const conversationId = createConversation(app.db, seeded.id, 'hs-caller')
    const userMessageId = insertMessage(app.db, {
      conversationId,
      role: 'user',
      content: 'Plan a trip',
    })
    createRun(app.db, conversationId, userMessageId, seeded.sessionId)

    const { client, transport } = await createMcpClient(app, 'test-mcp-token')
    const result = await client.callTool({
      name: 'message_teammate',
      arguments: { username: 'operator', name: 'Travel', text: 'Plan a trip' },
    })
    const payload = parseToolResult(result)

    expect(result.isError).toBeFalsy()
    expect(payload).toMatchObject({
      ok: true,
      from: 'Hermes',
      to: 'Travel',
      reply: 'Pack sunscreen.',
    })
    expect(listMessages(app.db, conversationId).map((message) => message.kind)).toEqual([
      'chat',
      'bot_sent',
      'bot_reply',
    ])

    await transport.close()
    await client.close()
  })

  it('lists set_my_responsibilities and message_teammate', async () => {
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['set_my_responsibilities', 'message_teammate']))

    await transport.close()
    await client.close()
  })

  it('set_my_responsibilities updates the caller bot only', async () => {
    const seeded = await seedTestUser(app!, 'operator2', 'password123')
    const travel = insertBot(app!.db, {
      userId: seeded.id,
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'You book trips.',
    })
    const other = insertBot(app!.db, {
      userId: seeded.id,
      slug: 'notes',
      name: 'Notes',
      role: 'Takes notes',
      soul: 'You take notes.',
    })
    const conversationId = createConversation(
      app!.db,
      seeded.id,
      'hs-jobs',
      null,
      undefined,
      travel.id,
    )
    const userMessageId = insertMessage(app!.db, {
      conversationId,
      role: 'user',
      content: 'You handle flights',
    })
    createRun(app!.db, conversationId, userMessageId, seeded.sessionId)

    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'set_my_responsibilities',
      arguments: {
        username: 'operator2',
        text: 'Flights, bookings, and tickets.',
      },
    })
    const payload = parseToolResult(result)

    expect(result.isError).toBeFalsy()
    expect(payload).toEqual({
      ok: true,
      name: 'Travel',
      slug: 'travel',
      responsibilities: 'Flights, bookings, and tickets.',
    })
    expect(getBotBySlug(app!.db, seeded.id, 'travel')?.responsibilities).toBe(
      'Flights, bookings, and tickets.',
    )
    expect(getBotBySlug(app!.db, seeded.id, 'notes')?.responsibilities).toBe('')
    expect(ensureDefaultBotRow(app!.db, seeded.id).responsibilities).toBe(
      'Default Companion assistant; routes matching work to specialist teammates.',
    )
    expect(other.slug).toBe('notes')

    await transport.close()
    await client.close()
  })

  it('set_my_responsibilities rejects empty or overlong jobs', async () => {
    const seeded = await seedTestUser(app!, 'operator3', 'password123')
    const travel = insertBot(app!.db, {
      userId: seeded.id,
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'You book trips.',
    })
    const conversationId = createConversation(
      app!.db,
      seeded.id,
      'hs-jobs-2',
      null,
      undefined,
      travel.id,
    )
    const userMessageId = insertMessage(app!.db, {
      conversationId,
      role: 'user',
      content: 'Set jobs',
    })
    createRun(app!.db, conversationId, userMessageId, seeded.sessionId)

    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')

    const empty = await client.callTool({
      name: 'set_my_responsibilities',
      arguments: { username: 'operator3', text: '   ' },
    })
    expect(empty.isError).toBe(true)
    expect(empty.content.find((part) => part.type === 'text')?.text).toContain(
      'responsibilities must be a non-empty string',
    )

    const tooLong = await client.callTool({
      name: 'set_my_responsibilities',
      arguments: { username: 'operator3', text: 'x'.repeat(201) },
    })
    expect(tooLong.isError).toBe(true)
    expect(tooLong.content.find((part) => part.type === 'text')?.text).toContain(
      'at most 200 characters',
    )

    expect(getBotBySlug(app!.db, seeded.id, 'travel')?.responsibilities).toBe('')

    await transport.close()
    await client.close()
  })
})