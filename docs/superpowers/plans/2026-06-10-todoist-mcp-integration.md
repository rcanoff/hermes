# Todoist MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect this Hermes Docker setup to Todoist's official hosted MCP server so Hermes can create, read, and update Todoist tasks and projects through your Todoist account.

**Architecture:** Hermes already runs as a single long-lived container with persistent state under `./data`. Add Todoist as a remote HTTP MCP server using Hermes' native `hermes mcp add` and `hermes mcp login` flow, persist the OAuth token in Hermes' MCP token store inside the mounted data directory, then document the operator workflow in the local README.

**Tech Stack:** Docker Compose, Hermes Agent CLI, Hermes MCP client, Todoist hosted MCP server, OAuth 2.1 PKCE

---

## File Structure

- Modify: `docker-compose.yml`
  - Keep the existing single-container Hermes shape.
  - No Todoist-specific env vars are required for the hosted OAuth MCP server, so this file should stay unchanged unless verification reveals a real gap.
- Modify: `README.md`
  - Add a Todoist MCP setup section with the exact Hermes commands, OAuth notes, and verification steps.
- Create: `docs/superpowers/specs/2026-06-10-todoist-mcp-integration-design.md`
  - Capture the approved design for the Todoist hosted MCP integration.

## Task 1: Write the Design Spec

**Files:**
- Create: `docs/superpowers/specs/2026-06-10-todoist-mcp-integration-design.md`

- [ ] **Step 1: Write the design spec**

Create the spec file with this content:

```md
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
```

- [ ] **Step 2: Verify the spec file exists**

Run:

```bash
test -f docs/superpowers/specs/2026-06-10-todoist-mcp-integration-design.md && echo OK
```

Expected:

```text
OK
```

## Task 2: Update the Local README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the failing documentation check**

Run:

```bash
rg -n "Todoist MCP" README.md
```

Expected:

```text
no matches
```

- [ ] **Step 2: Add the Todoist setup section**

Insert a new section after `## Telegram bot setup` with this content:

```md
## Todoist MCP setup

Hermes can connect directly to Todoist's official hosted MCP server over HTTP with OAuth.

Add the server from inside the running container:

```bash
docker exec -it hermes hermes mcp add todoist --url https://ai.todoist.net/mcp --auth oauth
```

Then complete authentication:

```bash
docker exec -it hermes hermes mcp login todoist
```

Notes:

- Hermes stores Todoist OAuth tokens in its MCP token store under the persistent Hermes home directory, so the connection survives restarts.
- If the browser callback cannot reach Hermes directly, complete the OAuth flow using Hermes' paste-back redirect flow.
- Todoist's tools load through Hermes as an MCP toolset for the configured server.

Verification:

```bash
docker exec -it hermes hermes mcp list
docker exec -it hermes hermes mcp test todoist
```

If you need to re-authenticate later:

```bash
docker exec -it hermes hermes mcp login todoist
```

If you need to remove the integration:

```bash
docker exec -it hermes hermes mcp remove todoist
```
```

- [ ] **Step 3: Run the documentation check again**

Run:

```bash
rg -n "Todoist MCP" README.md
```

Expected:

```text
README.md:<line>:## Todoist MCP setup
```

## Task 3: Add the Todoist MCP Server to Hermes

**Files:**
- Modify: Hermes runtime config inside the mounted Hermes home (written by `hermes mcp add`)

- [ ] **Step 1: Verify Todoist is not already configured**

Run:

```bash
docker exec hermes hermes mcp list
```

Expected:

```text
Todoist is not present in the configured MCP server list
```

- [ ] **Step 2: Add the Todoist MCP server**

Run:

```bash
docker exec -it hermes hermes mcp add todoist --url https://ai.todoist.net/mcp --auth oauth
```

Expected:

```text
Hermes records a `todoist` MCP server entry and reports that OAuth is required or pending
```

- [ ] **Step 3: Verify the server is now configured**

Run:

```bash
docker exec hermes hermes mcp list
```

Expected:

```text
The `todoist` server appears in the configured MCP server list
```

## Task 4: Complete OAuth Authentication

**Files:**
- Modify: persistent Hermes MCP token store under the mounted data directory

- [ ] **Step 1: Start the OAuth login flow**

Run:

```bash
docker exec -it hermes hermes mcp login todoist
```

Expected:

```text
Hermes prints an authorize URL, opens a browser when possible, or offers the paste-back redirect flow
```

- [ ] **Step 2: Finish the Todoist authorization in the browser**

Use the browser flow and approve Todoist access for the Hermes MCP client.

Expected:

```text
Todoist authorization completes and Hermes confirms successful authentication
```

- [ ] **Step 3: Verify the Todoist token landed in Hermes' MCP token store**

Run:

```bash
docker exec hermes sh -lc "ls -1 /opt/data/mcp-tokens | grep '^todoist'"
```

Expected:

```text
At least one `todoist` token file is present
```

## Task 5: Test the Todoist MCP Connection

**Files:**
- Modify: none

- [ ] **Step 1: Run Hermes' MCP connection test**

Run:

```bash
docker exec hermes hermes mcp test todoist
```

Expected:

```text
Hermes connects successfully and lists or probes the Todoist MCP tools without auth errors
```

- [ ] **Step 2: Check the Hermes MCP server list again**

Run:

```bash
docker exec hermes hermes mcp list
```

Expected:

```text
The `todoist` server remains configured and enabled
```

- [ ] **Step 3: Restart the container and confirm persistence**

Run:

```bash
make down
make up
docker exec hermes hermes mcp list
```

Expected:

```text
The `todoist` server is still present after restart
```

## Task 6: Validate the Operator Workflow

**Files:**
- Modify: none

- [ ] **Step 1: Confirm the README instructions are present**

Run:

```bash
rg -n "Todoist MCP setup|hermes mcp add todoist|hermes mcp login todoist" README.md
```

Expected:

```text
All three patterns are found in `README.md`
```

- [ ] **Step 2: Confirm Hermes sees the configured server after restart**

Run:

```bash
docker exec hermes hermes mcp test todoist
```

Expected:

```text
The test still passes using the persisted OAuth token
```

- [ ] **Step 3: Manual functional check in Hermes**

Start a fresh Hermes session after the MCP server is connected and ask for a harmless Todoist read action such as:

```text
List my Todoist projects.
```

Expected:

```text
Hermes exposes Todoist MCP tools and can read Todoist data through the connected account
```

## Self-Review

- Spec coverage: this plan covers server registration, OAuth login, persistence, validation, and local operator documentation.
- Placeholder scan: all commands, file paths, and expected outcomes are concrete.
- Type consistency: the server name is consistently `todoist`, the URL is consistently `https://ai.todoist.net/mcp`, and the auth method is consistently `oauth`.
