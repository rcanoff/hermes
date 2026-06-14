import type { FastifyPluginAsync } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { buildMcpToolHandlers, type McpToolHandlers } from '../services/mcp-tools.js'

export function isAuthorizedHeader(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!expectedToken || !authorization) {
    return false
  }

  const parts = authorization.trim().split(/\s+/)
  if (parts.length !== 2) {
    return false
  }

  const [scheme, token] = parts
  if (scheme === undefined || token === undefined) {
    return false
  }

  return scheme.toLowerCase() === 'bearer' && token === expectedToken
}

const mcpRoutes: FastifyPluginAsync = async (app) => {
  app.post('/mcp', async (request, reply) => {
    if (!isAuthorizedHeader(request.headers.authorization, app.companionMcpBearerToken)) {
      reply.header('WWW-Authenticate', 'Bearer realm="mcp"')
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const toolHandlers = buildMcpToolHandlers(app.db, 'operator')
    const mcpServer = createMcpServer(toolHandlers)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    const closeTransport = () => {
      reply.raw.off('close', closeTransport)
      void transport.close()
      void mcpServer.close()
    }

    try {
      await mcpServer.connect(transport as Parameters<McpServer['connect']>[0])
      reply.hijack()
      reply.raw.on('close', closeTransport)
      await transport.handleRequest(request.raw, reply.raw, request.body)
    } catch (error) {
      closeTransport()
      request.log.error({ err: error }, 'Error handling MCP request')
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500
        reply.raw.setHeader('Content-Type', 'application/json; charset=utf-8')
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          }),
        )
      }
    }
  })
}

export default mcpRoutes

function createMcpServer(toolHandlers: McpToolHandlers): McpServer {
  const server = new McpServer(
    {
      name: 'companion-messaging-api',
      version: '1.0.0',
    },
    {
      capabilities: {
        logging: {},
      },
    },
  )

  server.registerTool(
    'get_user_location',
    {
      description: 'Return the latest location event for the companion operator, or unavailability',
    },
    async () => executeToolCall(() => toolHandlers.get_user_location()),
  )

  server.registerTool(
    'get_location_history',
    {
      description: 'Return paginated location history for the companion operator',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of events to return (default 20, max 100)'),
        before: z
          .string()
          .optional()
          .describe('Optional event id cursor for pagination'),
      },
    },
    async (input) => executeToolCall(() => toolHandlers.get_location_history(input)),
  )

  return server
}

async function executeToolCall<T>(fn: () => Promise<T>) {
  try {
    const result = await fn()
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: {
        result,
      },
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: toErrorMessage(error),
        },
      ],
    }
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}