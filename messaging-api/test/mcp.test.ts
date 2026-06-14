import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createInviteRecord } from '../src/services/invites.js'
import { createTestApp } from './helpers/app.js'
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
    const firstPayload = parseToolResult(firstPage) as { events: Array<{ id: string; timestamp: string }> }

    expect(firstPayload.events).toHaveLength(2)
    expect(firstPayload.events[0]).toMatchObject({ id: createdIds[2], timestamp: timestamps[2] })
    expect(firstPayload.events[1]).toMatchObject({ id: createdIds[1], timestamp: timestamps[1] })

    const secondPage = await client.callTool({
      name: 'get_location_history',
      arguments: { username: 'operator', limit: 2, before: createdIds[1] },
    })
    const secondPayload = parseToolResult(secondPage) as { events: Array<{ id: string; timestamp: string }> }

    expect(secondPayload.events).toHaveLength(1)
    expect(secondPayload.events[0]).toMatchObject({ id: createdIds[0], timestamp: timestamps[0] })

    await transport.close()
    await client.close()
  })

  it('creates an activation invite via MCP', async () => {
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'create_companion_invite',
      arguments: { label: 'Roberto' },
    })
    const payload = parseToolResult(result) as { invite_id: string; url: string; expires_at: string }
    expect(payload.url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/invite\//)
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
})