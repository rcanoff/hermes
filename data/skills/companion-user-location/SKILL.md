---
name: companion-user-location
description: Data skill — fetch and normalize a companion user's location from the vault via MCP. Use for "where am I?", coordinates, address, travel near me, or historical location questions. Never Home Assistant.
version: 1.2.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [companion, location, mcp, mobile, maps, travel, data]
    related_skills: [companion-replies, companion-map-preview, companion-links, companion-account-management, companion-user-health]
---

# Companion User Location

## Overview

This is a **data skill**. It fetches location from the companion vault in `messaging-api` and normalizes the result into a fixed internal record. It does **not** own reply formatting — delegate presentation to `companion-replies` and `companion-map-preview` on Companion App channels.

The vault is the **only** source for companion user location. **Never** call Home Assistant, `request_location_update`, or any HA location skill.

## When to use

- "where am I?", coordinates, address, or position for travel / weather / routing
- "where was I …?", "when did I arrive …?", or other historical location questions
- Any other skill needs the operator's current coordinates (e.g. route origin = "here")

## Username resolution

| Channel | Default `username` for MCP calls |
|---------|----------------------------------|
| Companion App | The authenticated user for this conversation (injected in the Companion App system prompt) |
| Telegram / CLI / dashboard | The companion account the question refers to; ask if unclear |

Rules:

- On Companion App, **always** use the authenticated user's username unless the user explicitly asks about someone else.
- For cross-user questions on non-app channels, call `list_companion_accounts` from `companion-account-management` to discover usernames.
- Never guess a username.

## Tools (companion MCP)

- `get_user_location` — latest location; **requires `username`**
- `get_location_history` — paginated event log with HAL `_links`; **requires `username`** (`limit` default 20, max 100; optional `before` or `after` UUID anchors)

## Internal data format

After every MCP call, normalize into a **LocationRecord** before passing data to presentation skills or other workflows.

### Available

```yaml
available: true
username: <string>
lat: <number>
lon: <number>
accuracy_m: <number>
address: <string | null>
address_status: <string>          # e.g. resolved, pending
timestamp: <ISO-8601 string>
freshness: <string>               # e.g. "12 min ago"
trigger: <string>                 # manual | significant_change | interval
```

### Unavailable

```yaml
available: false
username: <string>
```

Do not emit user-facing prose from raw MCP JSON. Always normalize first.

## Output contract

This skill ends at a normalized **LocationRecord**. **Do not write the user reply.**

After normalize:

1. **STOP** — fetching data is not the final step.
2. Load **`companion-replies`** (required before any user-facing text).
3. On Companion App, load **`companion-map-preview`** when showing current position ("where am I?").
4. Only then compose the reply from the LocationRecord.

If you have a LocationRecord but have not loaded `companion-replies`, you are mid-workflow — do not send a reply yet.

## Data workflow — current location

1. Resolve `username` (see table above).
2. Call `get_user_location` via companion MCP.
3. Normalize the response into a LocationRecord.
4. Follow **Output contract** — hand off to presentation skills. Keep the record in working memory for downstream skills (e.g. `route-planner` using "here" as origin).

## Data workflow — history

For "where was I …?" or timeline questions:

1. Resolve `username`.
2. Call `get_location_history` with an appropriate `limit`.
3. Normalize each event to the available LocationRecord shape (add `id` from the event when useful).
4. Follow **Output contract** — load `companion-replies` before summarizing for the user.
5. To load older events, re-call with `before` from `_links.next.href`. Use `after` for newer pages via `_links.prev`.

## Consumers

- **`companion-map-preview`** — renders an available LocationRecord as a `type: place` map block on Companion App channels.
- **`companion-replies`** — owns plain-text location answers on non-app channels (Telegram, CLI, dashboard).

## Channel behavior

| Channel | Writes to vault | Reads location |
|---------|----------------|----------------|
| iOS companion | Yes | this skill → MCP |
| Telegram | No | this skill → MCP |
| CLI / dashboard | No | this skill → MCP |

Telegram does not ingest location. It reads whatever the app last shared. Report last-known with staleness or unavailability.

## Do not

- Write user-facing replies, map blocks, or Address/Coordinates/Accuracy/Updated lines — that is **`companion-replies`** + block skills
- Treat a successful MCP call as a finished turn

## Do not use

- `smart-home/home-assistant-mcp` or any Home Assistant entity for personal location
- Conversation location routes (removed; vault is user-scoped under `/data/location/*`)
- Legacy HA location skills (`roberto-location-source`, `generic-location-refresh`, `get-user-location`)