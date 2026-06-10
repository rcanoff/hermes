# Apple Calendar Custom CalDAV MCP Design

**Date:** 2026-06-10

## Goal

Connect Hermes to Apple/iCloud Calendar through a custom Docker-run MCP service so Hermes can read, create, update, and delete calendar events while Apple Calendar remains the source of truth and the iPhone Calendar app remains the human UI.

## Decisions

- Use Apple/iCloud Calendar as the backend and source of truth.
- Do not introduce a self-hosted calendar backend such as Radicale.
- Do not depend on a third-party CalDAV MCP implementation.
- Build a custom `apple-caldav-mcp` service in `Node.js` and `TypeScript`.
- Use a pinned `node:24-alpine` base image for the MCP container, not Node 18.
- Run that MCP as a separate service in the same `docker-compose.yml` stack as Hermes.
- Keep the MCP service internal to the Docker network; Hermes is the only client.
- Store Apple CalDAV credentials in this workspace's `.env`.
- Do not create an artificial per-calendar boundary in config; Hermes may access the account's calendars and will be steered by calendar name in prompts.
- Keep the service stateless. Every MCP tool call should talk directly to Apple/iCloud over CalDAV.
- Expose a normalized calendar and event schema to Hermes instead of raw CalDAV or iCalendar structures.
- Limit the first version to calendar and event CRUD only.

## Architecture

The existing workspace already runs Hermes as a single long-lived container with persistent state under `./data`. This integration adds a second service to the Compose stack for a custom `apple-caldav-mcp` server. That service authenticates to iCloud CalDAV using Apple credentials from `.env`, exposes its MCP HTTP interface only on the internal Compose network, and is not published to the host.

Hermes connects to the MCP service as a configured MCP server. Apple Calendar remains the sole data store; Hermes only integrates with it through MCP and does not store calendar events locally beyond normal auth/config state.

The MCP itself is stateless. It should not maintain its own event database, sync cache, or background reconciliation loop. Each tool call should resolve the requested calendar and perform the live CalDAV operation against iCloud.

## Service Shape

Selected implementation:

- Repository location: this workspace
- Runtime: `Node.js + TypeScript`
- Container base: pinned `node:24-alpine`
- Runtime mode: HTTP MCP server in a dedicated container
- Apple auth: CalDAV username plus Apple app-specific password
- Operator preference: no host port exposure; Hermes is the only MCP client

The service should be thin. It should translate MCP tool calls into CalDAV operations using a library rather than implementing DAV protocol details manually.

## Tool Surface

First version tools:

- `list_calendars`
- `list_events`
- `get_event`
- `create_event`
- `update_event`
- `delete_event`

These tools should use a normalized schema shaped for Hermes prompts rather than CalDAV internals. At minimum, events should be represented with fields such as:

- `calendar`
- `id`
- `title`
- `description`
- `location`
- `start`
- `end`
- `all_day`
- `timezone`
- `attendees`
- `status`

The service may keep internal CalDAV-specific fields such as ETags, raw event identifiers, and calendar URLs as implementation details.

## Data Handling

The MCP should be read-through and write-through only:

- no local event persistence
- no sync token store for the first version
- no offline mode
- no background polling

For mutating operations, the service should use stable identifiers and concurrency guards where practical. In particular, updates and deletes should use ETag-style checks or equivalent safeguards when the CalDAV library and iCloud behavior make that possible.

## Scope

In scope:

- implement a custom Node/TypeScript HTTP MCP server
- add it as a separate internal service in `docker-compose.yml`
- wire Apple CalDAV credentials via `.env`
- configure Hermes to use the MCP service
- support calendar and event CRUD
- document setup, verification, and operator workflow

Out of scope:

- self-hosted calendar backends
- contacts, tasks, or broader DAV support in the first version
- per-calendar access control boundaries inside the Apple account
- local caching, sync engines, or local event databases
- exposing the MCP service directly to the host or other clients

## Risks

- iCloud CalDAV auth and calendar discovery may have implementation quirks that require library-specific handling
- recurrence and timezone edge cases may complicate normalized event updates
- ETag and concurrent-edit behavior may differ across event operations and need careful testing
- Hermes sessions may need `/reload-mcp` or a fresh session after MCP changes
