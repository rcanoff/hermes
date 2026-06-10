import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createCaldavAdapter } from "./caldav.js";
import { loadConfig, type AppConfig } from "./config.js";
import { buildToolHandlers } from "./tools.js";

const eventSchema = {
  id: z.string().min(1).describe("Event identifier or URL"),
  calendar: z.string().min(1).describe("Calendar name or URL"),
  etag: z.string().min(1).optional().describe("Current event ETag for concurrency control"),
  title: z.string().min(1).describe("Event title"),
  description: z.string().optional().describe("Event description"),
  location: z.string().optional().describe("Event location"),
  start: z.string().min(1).describe("Event start time in ISO 8601 format"),
  end: z.string().min(1).describe("Event end time in ISO 8601 format"),
  allDay: z.boolean().describe("Whether the event is an all-day event"),
  timezone: z.string().optional().describe("IANA timezone for the event"),
  attendees: z.array(z.string()).describe("Attendee email addresses"),
  status: z
    .enum(["confirmed", "tentative", "cancelled"])
    .optional()
    .describe("Event participation status")
};

type ToolHandlers = ReturnType<typeof buildToolHandlers>;
type SignalName = "SIGINT" | "SIGTERM";
type CloseableServer = {
  close(callback: (error?: Error | undefined) => void): unknown;
};
type SignalProcess = {
  on(signal: SignalName, listener: () => void): unknown;
  exitCode?: string | number | null | undefined;
  exit(): unknown;
};

const registeredSignalProcesses = new WeakSet<object>();

export type RequestDecision =
  | { kind: "unauthorized"; statusCode: 401 }
  | { kind: "health"; statusCode: 200 }
  | { kind: "health_method_not_allowed"; statusCode: 405; allow: "GET, HEAD" }
  | { kind: "mcp"; statusCode: 200 }
  | { kind: "mcp_method_not_allowed"; statusCode: 405; allow: "POST" }
  | { kind: "not_found"; statusCode: 404 };

export function getRequestDecision(input: {
  pathname: string;
  method: string | undefined;
  authorization: string | undefined;
  expectedBearerToken: string;
}): RequestDecision {
  if (isProtectedPath(input.pathname) && !isAuthorizedHeader(input.authorization, input.expectedBearerToken)) {
    return {
      kind: "unauthorized",
      statusCode: 401
    };
  }

  if (input.pathname === "/health") {
    if (input.method !== "GET" && input.method !== "HEAD") {
      return {
        kind: "health_method_not_allowed",
        statusCode: 405,
        allow: "GET, HEAD"
      };
    }

    return {
      kind: "health",
      statusCode: 200
    };
  }

  if (input.pathname === "/mcp") {
    if (input.method !== "POST") {
      return {
        kind: "mcp_method_not_allowed",
        statusCode: 405,
        allow: "POST"
      };
    }

    return {
      kind: "mcp",
      statusCode: 200
    };
  }

  return {
    kind: "not_found",
    statusCode: 404
  };
}

export function createHttpRequestHandler(config: AppConfig) {
  const adapter = createCaldavAdapter(config);
  const toolHandlers = buildToolHandlers(adapter);

  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const decision = getRequestDecision({
        pathname: url.pathname,
        method: request.method,
        authorization: request.headers.authorization,
        expectedBearerToken: config.mcpBearerToken
      });

      switch (decision.kind) {
        case "unauthorized":
          response.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
          writeJson(response, decision.statusCode, { error: "Unauthorized" });
          return;
        case "health":
          writeJson(response, decision.statusCode, { status: "ok" });
          return;
        case "health_method_not_allowed":
        case "mcp_method_not_allowed":
          response.setHeader("Allow", decision.allow);
          writeJson(response, decision.statusCode, { error: "Method Not Allowed" });
          return;
        case "mcp":
          await handleMcpRequest(request, response, toolHandlers);
          return;
        case "not_found":
          writeJson(response, decision.statusCode, { error: "Not Found" });
          return;
      }
    } catch (error) {
      console.error("Unhandled server error:", error);
      if (!response.headersSent) {
        writeJson(response, 500, { error: "Internal Server Error" });
      } else {
        response.end();
      }
    }
  };
}

export function startServer(config: AppConfig = loadConfig()): Server {
  const httpServer = createServer(createHttpRequestHandler(config));

  httpServer.listen(config.port, () => {
    console.log(`apple-caldav-mcp listening on port ${config.port}`);
  });

  return httpServer;
}

export function registerSignalHandlers(
  httpServer: CloseableServer,
  runtimeProcess: SignalProcess = process
): void {
  if (registeredSignalProcesses.has(runtimeProcess)) {
    return;
  }

  registeredSignalProcesses.add(runtimeProcess);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    runtimeProcess.on(signal, () => {
      httpServer.close((error) => {
        if (error) {
          console.error(`Failed to shut down cleanly after ${signal}:`, error);
          runtimeProcess.exitCode = 1;
        }
        runtimeProcess.exit();
      });
    });
  }
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  toolHandlers: ToolHandlers
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writeJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  const mcpServer = createMcpServer(toolHandlers);
  const transport = new StreamableHTTPServerTransport();

  const closeTransport = () => {
    response.off("close", closeTransport);
    void transport.close();
    void mcpServer.close();
  };

  try {
    await mcpServer.connect(transport as Parameters<McpServer["connect"]>[0]);
    response.on("close", closeTransport);
    await transport.handleRequest(request, response);
  } catch (error) {
    closeTransport();
    console.error("Error handling MCP request:", error);
    if (!response.headersSent) {
      writeJson(response, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
}

function createMcpServer(toolHandlers: ToolHandlers): McpServer {
  const server = new McpServer(
    {
      name: "apple-caldav-mcp",
      version: "0.0.0"
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  server.registerTool(
    "list_calendars",
    {
      description: "List available calendars from the configured CalDAV account"
    },
    async () => executeToolCall(() => toolHandlers.list_calendars({}))
  );

  server.registerTool(
    "list_events",
    {
      description: "List events from a calendar, optionally filtered by time range",
      inputSchema: {
        calendar: z.string().min(1).describe("Calendar name or URL"),
        from: z.string().optional().describe("Inclusive range start in ISO 8601 format"),
        to: z.string().optional().describe("Inclusive range end in ISO 8601 format")
      }
    },
    async (input) => executeToolCall(() => toolHandlers.list_events(toListEventsInput(input)))
  );

  server.registerTool(
    "get_event",
    {
      description: "Fetch a single event by calendar and event identifier",
      inputSchema: {
        calendar: z.string().min(1).describe("Calendar name or URL"),
        id: z.string().min(1).describe("Event identifier or URL")
      }
    },
    async (input) => executeToolCall(() => toolHandlers.get_event(input))
  );

  server.registerTool(
    "create_event",
    {
      description: "Create a new calendar event",
      inputSchema: eventSchema
    },
    async (input) => executeToolCall(() => toolHandlers.create_event(toEventSummaryInput(input)))
  );

  server.registerTool(
    "update_event",
    {
      description: "Update an existing calendar event",
      inputSchema: eventSchema
    },
    async (input) => executeToolCall(() => toolHandlers.update_event(toEventSummaryInput(input)))
  );

  server.registerTool(
    "delete_event",
    {
      description: "Delete an event from a calendar",
      inputSchema: {
        calendar: z.string().min(1).describe("Calendar name or URL"),
        id: z.string().min(1).describe("Event identifier or URL"),
        etag: z.string().optional().describe("Current event ETag for concurrency control")
      }
    },
    async (input) =>
      executeToolCall(async () => {
        await toolHandlers.delete_event(toDeleteEventInput(input));
        return {
          deleted: true
        };
      })
  );

  return server;
}

async function executeToolCall<T>(fn: () => Promise<T>) {
  try {
    const result = await fn();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: {
        result
      }
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: toErrorMessage(error)
        }
      ]
    };
  }
}

function isAuthorizedHeader(authorization: string | undefined, expectedToken: string): boolean {
  if (!authorization) {
    return false;
  }

  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2) {
    return false;
  }

  const [scheme, token] = parts;
  if (scheme === undefined || token === undefined) {
    return false;
  }

  return scheme.toLowerCase() === "bearer" && token === expectedToken;
}

function isProtectedPath(pathname: string): boolean {
  return pathname === "/health" || pathname === "/mcp";
}

function toListEventsInput(input: {
  calendar: string;
  from?: string | undefined;
  to?: string | undefined;
}): { calendar: string; from?: string; to?: string } {
  return {
    calendar: input.calendar,
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to })
  };
}

function toEventSummaryInput(input: {
  id: string;
  calendar: string;
  etag?: string | undefined;
  title: string;
  description?: string | undefined;
  location?: string | undefined;
  start: string;
  end: string;
  allDay: boolean;
  timezone?: string | undefined;
  attendees: string[];
  status?: "confirmed" | "tentative" | "cancelled" | undefined;
}) {
  return {
    id: input.id,
    calendar: input.calendar,
    ...(input.etag === undefined ? {} : { etag: input.etag }),
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.location === undefined ? {} : { location: input.location }),
    start: input.start,
    end: input.end,
    allDay: input.allDay,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    attendees: input.attendees,
    ...(input.status === undefined ? {} : { status: input.status })
  };
}

function toDeleteEventInput(input: {
  calendar: string;
  id: string;
  etag?: string | undefined;
}): { calendar: string; id: string; etag?: string } {
  return {
    calendar: input.calendar,
    id: input.id,
    ...(input.etag === undefined ? {} : { etag: input.etag })
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (response.req?.method === "HEAD") {
    response.end();
    return;
  }

  response.end(JSON.stringify(body));
}

function isMainModule(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === metaUrl;
}

if (isMainModule(import.meta.url)) {
  const httpServer = startServer();
  registerSignalHandlers(httpServer);
}
