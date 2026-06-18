import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

async function createMcpClient(app: FastifyInstance) {
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: {
      headers: { Authorization: 'Bearer test-mcp-token' },
    },
  })
  const client = new Client({ name: 'mcp-job-test', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

function parseToolResult(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((part) => part.type === 'text')?.text
  expect(text).toBeDefined()
  return JSON.parse(text!) as Record<string, unknown>
}

describe('job conversation MCP tools', () => {
  let app: FastifyInstance | undefined

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    await seedTestUser(app, 'operator', 'password123')
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('creates and links a job conversation', async () => {
    const { client, transport } = await createMcpClient(app!)

    const created = await client.callTool({
      name: 'create_job_conversation',
      arguments: { username: 'operator', name: 'HA digest', schedule_display: '30 9 * * *' },
    })
    const createPayload = parseToolResult(created)
    expect(createPayload).toMatchObject({
      conversation_id: expect.any(String),
      kind: 'job',
    })

    const linked = await client.callTool({
      name: 'link_job_conversation',
      arguments: {
        username: 'operator',
        conversation_id: createPayload.conversation_id,
        hermes_job_id: 'abc123job',
      },
    })
    const linkPayload = parseToolResult(linked)
    expect(linkPayload).toEqual({
      conversation_id: createPayload.conversation_id,
      hermes_job_id: 'abc123job',
    })

    const row = app!.db
      .prepare('SELECT kind, hermes_job_id, bootstrap_prompt FROM conversations WHERE id = ?')
      .get(createPayload.conversation_id as string) as {
      kind: string
      hermes_job_id: string
      bootstrap_prompt: string
    }
    expect(row.kind).toBe('job')
    expect(row.hermes_job_id).toBe('abc123job')
    expect(row.bootstrap_prompt).toContain('companion-cron')

    await transport.close()
    await client.close()
  })
})