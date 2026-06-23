#!/usr/bin/env node
/**
 * MCP bridge: exposes headless Grok as codex-style delegate tools for the orchestrator.
 * Tools: grok (new session), grok-reply (resume by sessionId).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "../messaging-api/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StdioServerTransport } from "../messaging-api/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import * as z from "../messaging-api/node_modules/zod/v4/index.js";

const HERMES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CWD = HERMES_ROOT;

async function runGrok({ prompt, cwd = DEFAULT_CWD, sessionId, model, maxTurns }) {
  const args = [
    "-p",
    prompt,
    "--cwd",
    cwd,
    "--yolo",
    "--output-format",
    "json",
    "--no-auto-update",
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }
  if (model) {
    args.push("-m", model);
  }
  if (maxTurns) {
    args.push("--max-turns", String(maxTurns));
  }

  return new Promise((resolve, reject) => {
    const child = spawn("grok", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `grok exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }

      try {
        const payload = JSON.parse(stdout.trim());
        if (payload.type === "error") {
          reject(new Error(payload.message ?? "grok returned an error"));
          return;
        }
        resolve({
          sessionId: payload.sessionId ?? sessionId ?? null,
          content: payload.text ?? "",
          stopReason: payload.stopReason ?? null,
        });
      } catch (error) {
        reject(
          new Error(
            `Failed to parse grok JSON output: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

const server = new McpServer({
  name: "grok-hermes-mcp-server",
  version: "1.0.0",
});

server.registerTool(
  "grok",
  {
    description:
      "Run a headless Grok session for Hermes/backend work. Returns sessionId for follow-ups.",
    inputSchema: {
      prompt: z.string().describe("Task brief for the Grok backend agent."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory. Defaults to the hermes repo root."),
      model: z.string().optional().describe("Optional Grok model override."),
      maxTurns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum agentic turns before stopping."),
    },
  },
  async ({ prompt, cwd, model, maxTurns }) => {
    const result = await runGrok({ prompt, cwd, model, maxTurns });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "grok-reply",
  {
    description: "Continue a headless Grok session by sessionId.",
    inputSchema: {
      prompt: z.string().describe("Follow-up instructions."),
      sessionId: z.string().describe("Session id from a prior grok tool call."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory. Defaults to the hermes repo root."),
      model: z.string().optional().describe("Optional Grok model override."),
      maxTurns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum agentic turns before stopping."),
    },
  },
  async ({ prompt, sessionId, cwd, model, maxTurns }) => {
    const result = await runGrok({
      prompt,
      cwd,
      sessionId,
      model,
      maxTurns,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);