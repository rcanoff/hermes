---
name: companion-user-location
description: Use when the user asks for their current location, coordinates, address, map links, travel or weather near them, or historical "where was I" questions. Read from the companion location vault via MCP — never Home Assistant.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [companion, location, mcp, mobile, maps, travel]
    related_skills: []
---

# Companion User Location

## Overview

The companion location vault in `messaging-api` is the **only** source for the operator's location. All channels (iOS companion, Telegram, CLI, dashboard) read through this skill and the companion MCP server.

**Never** call Home Assistant, `request_location_update`, or any HA location skill for personal location answers.

## When to use

- "where am I?", coordinates, address, map links
- Travel, maps, weather-near-me, or any task needing the user's position
- "where was I …?", "when did I arrive …?", or other historical location questions

## Tools

Use the **companion** MCP server:

- `get_user_location` — latest location for a companion user; **requires `username`**
- `get_location_history` — paginated event log; **requires `username`** (`limit` default 20, max 100; optional `before` cursor)

For a single-operator household, the `username` is whichever companion account the question refers to. If unclear, ask the user or use `list_companion_accounts` from the `companion-account-management` skill to discover usernames.

## Current location workflow

1. Call `get_user_location` with the target `username` via companion MCP.
2. If `available: false` → tell the user location is not available; suggest sharing location from the companion app.
3. If `available: true` → respond in this fixed four-line format (compact; no extra prose):

   ```
   Address: ...
   Coordinates: lat, lon
   Accuracy: Xm
   Updated: 12 min ago
   ```

   Use the `freshness` field for the "Updated" line when present. An optional Apple Maps link is fine.

4. If `address_status: pending` → show coordinates and accuracy; omit the address line or note that the address is still resolving.
5. If coordinates are stale, say so using `freshness` or `timestamp` — do not invent a fresher position.

## Historical location workflow

For "where was I …?" or timeline questions:

1. Call `get_location_history` with the target `username` and an appropriate `limit`.
2. Summarize matching events by timestamp, coordinates, and address when resolved.
3. Use `before` to paginate if the user needs older events.

## Channel behavior

| Channel | Writes to vault | Reads location |
|---------|----------------|----------------|
| iOS companion | Yes | skill → MCP |
| Telegram | No | skill → MCP |
| CLI / dashboard | No | skill → MCP |

Telegram does not ingest location. It reads whatever the app last shared. If the app has not posted recently, report last-known with staleness or unavailability.

## Do not use

- `smart-home/home-assistant-mcp` or any Home Assistant entity for the operator's location
- Conversation location routes (removed; vault is user-scoped under `/data/location/*`)
- Skills that refresh HA Companion App location (`roberto-location-source`, `generic-location-refresh`, `get-user-location`)