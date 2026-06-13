# Apple Calendar Custom CalDAV MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a custom internal-only Apple Calendar MCP service in this workspace so Hermes can control iCloud calendars and events through live CalDAV calls while Apple remains the source of truth.

**Architecture:** Replace the partially-wired third-party `dav-mcp` path with a custom stateless Node.js/TypeScript HTTP MCP service. The service runs as a separate container in the existing Compose stack, authenticates to iCloud with `.env` credentials, exposes a bearer-protected `/mcp` endpoint on the internal Docker network, and is registered in Hermes through `data/config.yaml`.

**Tech Stack:** Node.js 24 Alpine, TypeScript, pnpm, `@modelcontextprotocol/sdk`, `tsdav`, Docker Compose, Hermes Agent CLI

---

## File Structure

- Create: `apple-caldav-mcp/package.json`
  - package manifest, scripts, runtime dependencies, dev dependencies
- Create: `apple-caldav-mcp/tsconfig.json`
  - TypeScript compiler config for Node 24
- Create: `apple-caldav-mcp/src/types.ts`
  - normalized calendar and event types used across the service
- Create: `apple-caldav-mcp/src/config.ts`
  - environment loading and validation
- Create: `apple-caldav-mcp/src/caldav.ts`
  - CalDAV client creation and live operations via `tsdav`
- Create: `apple-caldav-mcp/src/ical.ts`
  - iCalendar parsing and serialization helpers
- Create: `apple-caldav-mcp/src/tools.ts`
  - MCP tool definitions and handlers
- Create: `apple-caldav-mcp/src/server.ts`
  - HTTP MCP server entrypoint
- Create: `apple-caldav-mcp/src/__tests__/config.test.ts`
  - config validation tests
- Create: `apple-caldav-mcp/src/__tests__/ical.test.ts`
  - normalized event mapping tests
- Create: `apple-caldav-mcp/src/__tests__/tools.test.ts`
  - tool handler tests with mocked CalDAV layer
- Create: `docker/apple-caldav-mcp/Dockerfile`
  - pinned `node:24-alpine` runtime image
- Create: `docker/apple-caldav-mcp/.dockerignore`
  - keep image context small
- Create: `.dockerignore`
  - bound the active repo-root Docker build context to only the MCP image inputs
- Create: `scripts/sync-apple-calendar-mcp-token.sh`
  - sync the Apple Calendar bearer token from the selected env file into `data/config.yaml`
- Modify: `docker-compose.yml`
  - replace the stale third-party MCP build with the custom service
- Modify: `.env.example`
  - keep Apple CalDAV credentials and bearer token placeholders
- Modify: `Makefile`
  - sync the Apple Calendar bearer token before `make up` and `make config`
- Modify: `README.md`
  - replace the third-party MCP section with custom service setup and Hermes registration steps
- Modify: `data/config.yaml`
  - add the `apple_calendar` MCP server block that points Hermes at the internal service
- Delete: `docker/dav-mcp/Dockerfile`
  - remove the abandoned third-party packaging path

## Task 1: Replace the Stale Third-Party Direction in Workspace Docs and Layout

**Files:**
- Modify: `docs/superpowers/implemented/specs/2026-06-10-apple-calendar-caldav-mcp-design.md`
- Modify: `docs/superpowers/implemented/plans/2026-06-10-apple-calendar-caldav-mcp.md`
- Delete: `docker/dav-mcp/Dockerfile`

- [ ] **Step 1: Confirm the stale third-party path is still present**

Run:

```bash
rg -n "dav-mcp|PhilflowIO|third-party" docker-compose.yml README.md docs docker
```

Expected:

```text
Matches exist in the current workspace and need to be replaced by the custom MCP plan.
```

- [ ] **Step 2: Remove the abandoned third-party Dockerfile**

Delete:

```text
docker/dav-mcp/Dockerfile
```

- [ ] **Step 3: Verify the stale Dockerfile is gone**

Run:

```bash
test ! -f docker/dav-mcp/Dockerfile && echo OK
```

Expected:

```text
OK
```

## Task 2: Scaffold the Custom Node/TypeScript MCP Package

**Files:**
- Create: `apple-caldav-mcp/package.json`
- Create: `apple-caldav-mcp/tsconfig.json`

- [ ] **Step 1: Write the package manifest**

Create `apple-caldav-mcp/package.json`:

```json
{
  "name": "apple-caldav-mcp",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --loader tsx src/server.ts",
    "start": "node dist/server.js",
    "test": "node --test dist/__tests__/*.test.js",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ical.js": "^2.2.1",
    "tsdav": "^2.1.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Write the TypeScript config**

Create `apple-caldav-mcp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run:

```bash
cd apple-caldav-mcp && pnpm install
```

Expected:

```text
Dependencies install successfully and `pnpm-lock.yaml` is created under `apple-caldav-mcp/`.
```

- [ ] **Step 4: Verify the package install is complete**

Run:

```bash
cd apple-caldav-mcp && pnpm list --depth 0
```

Expected:

```text
Exit 0 and show the direct dependencies from `package.json`.
```

## Task 3: Define Config and Normalized Types with Tests First

**Files:**
- Create: `apple-caldav-mcp/src/types.ts`
- Create: `apple-caldav-mcp/src/config.ts`
- Create: `apple-caldav-mcp/src/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing config test**

Create `apple-caldav-mcp/src/__tests__/config.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

test("loadConfig returns validated runtime settings", () => {
  const config = loadConfig({
    PORT: "3000",
    MCP_BEARER_TOKEN: "secret",
    APPLE_CALDAV_URL: "https://caldav.icloud.com",
    APPLE_CALDAV_USERNAME: "user@example.com",
    APPLE_CALDAV_APP_PASSWORD: "app-password"
  });

  assert.equal(config.port, 3000);
  assert.equal(config.mcpBearerToken, "secret");
  assert.equal(config.caldavUrl, "https://caldav.icloud.com");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apple-caldav-mcp && pnpm build && node --test dist/__tests__/config.test.js
```

Expected:

```text
FAIL because `config.ts` does not exist yet.
```

- [ ] **Step 3: Write the normalized types**

Create `apple-caldav-mcp/src/types.ts`:

```ts
export type CalendarSummary = {
  id: string;
  name: string;
  url: string;
};

export type EventSummary = {
  id: string;
  calendar: string;
  etag?: string;
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone?: string;
  attendees: string[];
  status?: "confirmed" | "tentative" | "cancelled";
};
```

- [ ] **Step 4: Write the config loader**

Create `apple-caldav-mcp/src/config.ts`:

```ts
import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.string().default("3000"),
  MCP_BEARER_TOKEN: z.string().min(1),
  APPLE_CALDAV_URL: z.string().url(),
  APPLE_CALDAV_USERNAME: z.string().min(1),
  APPLE_CALDAV_APP_PASSWORD: z.string().min(1)
});

export type AppConfig = {
  port: number;
  mcpBearerToken: string;
  caldavUrl: string;
  caldavUsername: string;
  caldavPassword: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(env);
  return {
    port: Number(parsed.PORT),
    mcpBearerToken: parsed.MCP_BEARER_TOKEN,
    caldavUrl: parsed.APPLE_CALDAV_URL,
    caldavUsername: parsed.APPLE_CALDAV_USERNAME,
    caldavPassword: parsed.APPLE_CALDAV_APP_PASSWORD
  };
}
```

- [ ] **Step 5: Re-run the test to verify it passes**

Run:

```bash
cd apple-caldav-mcp && pnpm build && node --test dist/__tests__/config.test.js
```

Expected:

```text
PASS
```

- [ ] **Step 6: Verify the package now typechecks once source files exist**

Run:

```bash
cd apple-caldav-mcp && pnpm typecheck
```

Expected:

```text
Exit 0
```

## Task 4: Build the iCalendar Mapping Layer with Tests First

**Files:**
- Create: `apple-caldav-mcp/src/ical.ts`
- Create: `apple-caldav-mcp/src/__tests__/ical.test.ts`

- [ ] **Step 1: Write the failing event-mapping test**

Create `apple-caldav-mcp/src/__tests__/ical.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseEventIcs } from "../ical.js";

test("parseEventIcs maps VEVENT into normalized event shape", () => {
  const event = parseEventIcs("Work", "etag-1", `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-1
SUMMARY:Buy milk
DESCRIPTION:2 liters
DTSTART:20260611T090000Z
DTEND:20260611T093000Z
END:VEVENT
END:VCALENDAR`);

  assert.equal(event.calendar, "Work");
  assert.equal(event.id, "event-1");
  assert.equal(event.title, "Buy milk");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apple-caldav-mcp && pnpm build && node --test dist/__tests__/ical.test.js
```

Expected:

```text
FAIL because `ical.ts` does not exist yet.
```

- [ ] **Step 3: Implement the parser and serializer helpers**

Create `apple-caldav-mcp/src/ical.ts` with functions shaped like:

```ts
export function parseEventIcs(calendar: string, etag: string | undefined, raw: string): EventSummary
export function buildEventIcs(input: Omit<EventSummary, "etag">): string
```

Implementation requirements:

- parse `UID`, `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`, `DTEND`, `STATUS`
- normalize attendee mailto values to plain email strings
- output ISO timestamps for `start` and `end`
- support all-day events when date-only values are present

- [ ] **Step 4: Re-run the test to verify it passes**

Run:

```bash
cd apple-caldav-mcp && pnpm build && node --test dist/__tests__/ical.test.js
```

Expected:

```text
PASS
```

## Task 5: Implement the Live CalDAV Adapter

**Files:**
- Create: `apple-caldav-mcp/src/caldav.ts`

- [ ] **Step 1: Implement the adapter surface**

Create `apple-caldav-mcp/src/caldav.ts` with this exported contract:

```ts
import type { AppConfig } from "./config.js";
import type { CalendarSummary, EventSummary } from "./types.js";

export type CaldavAdapter = {
  listCalendars(): Promise<CalendarSummary[]>;
  listEvents(calendarName: string, from?: string, to?: string): Promise<EventSummary[]>;
  getEvent(calendarName: string, eventId: string): Promise<EventSummary>;
  createEvent(input: EventSummary): Promise<EventSummary>;
  updateEvent(input: EventSummary): Promise<EventSummary>;
  deleteEvent(calendarName: string, eventId: string, etag?: string): Promise<void>;
};

export function createCaldavAdapter(config: AppConfig): CaldavAdapter
```

- [ ] **Step 2: Implement calendar discovery**

Use `tsdav` to:

- create the DAV client from `APPLE_CALDAV_URL`, username, and app-specific password
- resolve available calendars
- return normalized `CalendarSummary` values with stable ids and names

- [ ] **Step 3: Implement live event operations**

Implement each method as a live read-through/write-through operation:

- `listEvents`: query the named calendar and map raw ICS to `EventSummary`
- `getEvent`: resolve a single event by stable id
- `createEvent`: build ICS and upload it
- `updateEvent`: replace the existing resource while honoring ETag when available
- `deleteEvent`: delete the resource, using ETag preconditions when available

- [ ] **Step 4: Verify the package still typechecks**

Run:

```bash
cd apple-caldav-mcp && pnpm typecheck
```

Expected:

```text
Exit 0
```

## Task 6: Implement the MCP Tool Layer with Tests First

**Files:**
- Create: `apple-caldav-mcp/src/tools.ts`
- Create: `apple-caldav-mcp/src/__tests__/tools.test.ts`

- [ ] **Step 1: Write the failing tool test**

Create `apple-caldav-mcp/src/__tests__/tools.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildToolHandlers } from "../tools.js";

test("list_calendars delegates to the adapter", async () => {
  const handlers = buildToolHandlers({
    listCalendars: async () => [{ id: "1", name: "Home", url: "u" }],
    listEvents: async () => [],
    getEvent: async () => { throw new Error("unused"); },
    createEvent: async () => { throw new Error("unused"); },
    updateEvent: async () => { throw new Error("unused"); },
    deleteEvent: async () => {}
  });

  const result = await handlers.list_calendars({});
  assert.equal(result[0].name, "Home");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apple-caldav-mcp && pnpm build && node --test dist/__tests__/tools.test.js
```

Expected:

```text
FAIL because `tools.ts` does not exist yet.
```

- [ ] **Step 3: Implement the tool handlers**

Create `apple-caldav-mcp/src/tools.ts`:

```ts
import type { CaldavAdapter } from "./caldav.js";

export function buildToolHandlers(adapter: CaldavAdapter) {
  return {
    list_calendars: async () => adapter.listCalendars(),
    list_events: async (input: { calendar: string; from?: string; to?: string }) =>
      adapter.listEvents(input.calendar, input.from, input.to),
    get_event: async (input: { calendar: string; id: string }) =>
      adapter.getEvent(input.calendar, input.id),
    create_event: async (input: EventSummary) => adapter.createEvent(input),
    update_event: async (input: EventSummary) => adapter.updateEvent(input),
    delete_event: async (input: { calendar: string; id: string; etag?: string }) =>
      adapter.deleteEvent(input.calendar, input.id, input.etag)
  };
}
```

- [ ] **Step 4: Re-run the test to verify it passes**

Run:

```bash
cd apple-caldav-mcp && pnpm build && node --test dist/__tests__/tools.test.js
```

Expected:

```text
PASS
```

## Task 7: Build the HTTP MCP Server

**Files:**
- Create: `apple-caldav-mcp/src/server.ts`

- [ ] **Step 1: Implement the HTTP server entrypoint**

Create `apple-caldav-mcp/src/server.ts` with these responsibilities:

- load and validate env using `loadConfig()`
- create the CalDAV adapter
- register the six MCP tools
- enforce bearer auth on incoming HTTP requests
- expose a health endpoint at `/health`
- expose the MCP endpoint at `/mcp`

- [ ] **Step 2: Verify the build succeeds**

Run:

```bash
cd apple-caldav-mcp && pnpm build
```

Expected:

```text
TypeScript compiles to `apple-caldav-mcp/dist`.
```

## Task 8: Replace Compose Wiring with the Custom Service

**Files:**
- Create: `docker/apple-caldav-mcp/Dockerfile`
- Create: `docker/apple-caldav-mcp/.dockerignore`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Create the Dockerfile**

Create `docker/apple-caldav-mcp/Dockerfile`:

```dockerfile
FROM node:24-alpine

WORKDIR /app

COPY apple-caldav-mcp/package.json apple-caldav-mcp/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY apple-caldav-mcp/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

This image shape assumes the MCP package is built and tested on the host first, then the runtime image copies only the compiled `dist` output and production dependencies.

- [ ] **Step 2: Create the Docker ignore file**

Create `docker/apple-caldav-mcp/.dockerignore`:

```text
node_modules
dist
.git
```

- [ ] **Step 3: Bound the active repo-root Docker build context**

Because `docker-compose.yml` uses `build.context: .`, add a repo-root `.dockerignore` that only allows the MCP image inputs into the build context.

At minimum it should include:

```text
*
!apple-caldav-mcp/
!apple-caldav-mcp/package.json
!apple-caldav-mcp/pnpm-lock.yaml
!apple-caldav-mcp/dist/
!apple-caldav-mcp/dist/**
!docker/
!docker/apple-caldav-mcp/
!docker/apple-caldav-mcp/Dockerfile
```

- [ ] **Step 4: Replace the stale Compose service**

Update `docker-compose.yml` so `apple-caldav-mcp`:

- builds from `docker/apple-caldav-mcp/Dockerfile`
- no longer references `AUTH_METHOD`, `CALDAV_SERVER_URL`, or `BEARER_TOKEN`
- instead uses:

```yaml
APPLE_CALDAV_URL: ${APPLE_CALDAV_URL:-https://caldav.icloud.com}
APPLE_CALDAV_USERNAME: ${APPLE_CALDAV_USERNAME:-}
APPLE_CALDAV_APP_PASSWORD: ${APPLE_CALDAV_APP_PASSWORD:-}
MCP_BEARER_TOKEN: ${CALDAV_MCP_BEARER_TOKEN:-}
PORT: 3000
```

- [ ] **Step 5: Add automatic bearer-token sync**

Create `scripts/sync-apple-calendar-mcp-token.sh` and wire it into `Makefile` so:

- `make sync-apple-calendar-mcp-token` updates the `apple_calendar` Authorization header in `data/config.yaml` from the selected env file
- `make up` runs the sync before `docker compose up -d`
- `make config` runs the sync before `docker compose config`

The sync must:

- fail if `CALDAV_MCP_BEARER_TOKEN` is empty in the selected env file
- avoid printing the token value
- update only the `apple_calendar` Authorization header

- [ ] **Step 6: Verify Compose renders**

Run:

```bash
docker compose --env-file .env.example config
```

Expected:

```text
Compose renders successfully with the custom service definition.
```

## Task 9: Register the MCP in Hermes and Document It

**Files:**
- Modify: `data/config.yaml`
- Modify: `README.md`

- [ ] **Step 1: Add the Hermes MCP config block**

Add this block under `mcp_servers:` in `data/config.yaml`:

```yaml
  apple_calendar:
    url: http://apple-caldav-mcp:3000/mcp
    headers:
      Authorization: Bearer REPLACE_ME
    enabled: true
```

Then replace `REPLACE_ME` with the actual `CALDAV_MCP_BEARER_TOKEN` value from the selected env file during implementation, without printing it in logs or the final response.

After the initial replacement, the Makefile-backed sync step becomes the operational path for keeping this header aligned with the env file.

- [ ] **Step 2: Rewrite the Apple Calendar README section**

Document:

- custom service purpose
- `.env` keys required
- first build behavior
- how Hermes reaches the service
- automatic token sync behavior
- how to reload MCP
- how to verify safe reads first

- [ ] **Step 3: Add operator verification commands**

Include these commands in `README.md`:

```bash
make down
make up
docker compose ps
docker compose logs --tail=100 apple-caldav-mcp
docker exec -it hermes hermes mcp list
docker exec -it hermes hermes mcp test apple_calendar
```

Expected:

```text
The README matches the custom MCP architecture and no longer mentions the third-party `dav-mcp` implementation.
```

## Task 10: End-to-End Verification

**Files:**
- Modify: none

- [ ] **Step 1: Build the custom service image**

Run:

```bash
docker compose --env-file .env build apple-caldav-mcp
```

Expected:

```text
The custom MCP image builds successfully on `node:24-alpine`.
```

- [ ] **Step 2: Start the stack**

Run:

```bash
make down
make up
```

Expected:

```text
Both `hermes` and `apple-caldav-mcp` are running.
```

- [ ] **Step 3: Verify the service health**

Run:

```bash
docker compose ps
docker compose logs --tail=100 apple-caldav-mcp
```

Expected:

```text
The MCP service starts cleanly and listens on port 3000.
```

- [ ] **Step 4: Verify Hermes sees the MCP**

Run:

```bash
docker exec hermes hermes mcp list
docker exec hermes hermes mcp test apple_calendar
```

Expected:

```text
Hermes lists `apple_calendar` and discovers the custom tool surface.
```

- [ ] **Step 5: Verify safe read behavior first**

In a fresh Hermes session or after `/reload-mcp`, ask:

```text
List my Apple calendars.
```

Expected:

```text
Hermes returns the available iCloud calendars through the custom MCP.
```

## Self-Review

- Spec coverage: this plan covers the custom Node/TypeScript MCP, stateless CalDAV access, normalized event schema, Docker service, Hermes registration, and operator verification path.
- Placeholder scan: removed the old third-party MCP assumptions and replaced them with concrete file paths and commands.
- Type consistency: the plan consistently uses `apple-caldav-mcp`, `apple_calendar`, `APPLE_CALDAV_*`, and `CALDAV_MCP_BEARER_TOKEN`.
