import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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
  const client = new Client({ name: 'mcp-location-test-client', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport, address }
}

function parseToolResult(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((part) => part.type === 'text')?.text
  expect(text).toBeDefined()
  return JSON.parse(text!) as Record<string, unknown>
}

describe('get_user_location_for_user_id MCP tool', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let operatorUserId: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token
    operatorUserId = seeded.id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns latest location for a valid user_id', async () => {
    await app!.inject({
      method: 'POST',
      url: '/data/location/events',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        lat: 52.52,
        lon: 13.405,
        accuracy_m: 12.5,
        timestamp: '2026-06-13T09:48:00.000Z',
        trigger: 'significant_change',
        source: 'ios',
        address: 'Berlin, Germany',
      },
    })

    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'get_user_location_for_user_id',
      arguments: { user_id: operatorUserId },
    })
    const payload = parseToolResult(result)

    expect(payload).toEqual({
      available: true,
      user_id: operatorUserId,
      latitude: 52.52,
      longitude: 13.405,
      accuracy_meters: 12.5,
      synced_at: '2026-06-13T09:48:00.000Z',
      address: 'Berlin, Germany',
    })

    await transport.close()
    await client.close()
  })

  it('returns unavailable when user has no location events', async () => {
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'get_user_location_for_user_id',
      arguments: { user_id: operatorUserId },
    })
    const payload = parseToolResult(result)

    expect(payload).toEqual({
      available: false,
      user_id: operatorUserId,
    })

    await transport.close()
    await client.close()
  })

  it('returns tool error for unknown user_id', async () => {
    const unknownUserId = randomUUID()
    const { client, transport } = await createMcpClient(app!, 'test-mcp-token')
    const result = await client.callTool({
      name: 'get_user_location_for_user_id',
      arguments: { user_id: unknownUserId },
    })

    expect(result.isError).toBe(true)
    const text = result.content.find((part) => part.type === 'text')?.text
    expect(text).toContain(`User "${unknownUserId}" not found`)

    await transport.close()
    await client.close()
  })
})