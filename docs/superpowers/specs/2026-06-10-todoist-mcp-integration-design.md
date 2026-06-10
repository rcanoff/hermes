# Todoist MCP Integration Design

**Date:** 2026-06-10

## Goal

Connect Hermes to Todoist's official hosted MCP server so Hermes can manage Todoist-backed shopping lists and shared tasks through the user's Todoist account.

## Decisions

- Use Todoist's hosted MCP endpoint: `https://ai.todoist.net/mcp`
- Use Hermes' native MCP HTTP client support instead of a custom Todoist REST integration
- Use OAuth (`auth: oauth`) instead of manual API token wiring
- Bind Hermes to one Todoist account that already has access to any shared lists/projects
- Keep Todoist state in Todoist itself; Hermes is only the MCP client

## Architecture

Hermes already runs as a single Docker container with persistent state mounted at `/opt/data`. The Todoist integration will be added by invoking `hermes mcp add todoist --url https://ai.todoist.net/mcp --auth oauth` inside the running container. Hermes will store the OAuth token in its MCP token store under the persistent home directory, so the Todoist connection survives container restarts and recreates.

Once connected, Hermes will expose Todoist tools through a dynamic `mcp-todoist` toolset. Those tools will then be available to the Hermes chat/gateway surfaces according to the platform tool configuration.

## Scope

In scope:

- connect Todoist's hosted MCP server to Hermes
- complete the OAuth flow
- verify Hermes can see the Todoist MCP server
- document the local operator workflow for setup, re-auth, and testing

Out of scope:

- custom Todoist API wrappers
- multi-account Todoist routing
- automatic project/list opinionation beyond whatever Todoist MCP exposes

## Risks

- OAuth must be completed from a terminal flow that can open a browser or accept a pasted redirect URL
- MCP tools may not load into an already-running Hermes session until the next session/reload
- The exact Todoist tool names are server-defined and should be verified live after connection
