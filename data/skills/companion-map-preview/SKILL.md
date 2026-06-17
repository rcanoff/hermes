---
name: companion-map-preview
description: Format Hermes replies with root-level map preview blocks for the assistant-companion app. Use when Hermes wants the client to render a native map preview for a place or route inside a chat bubble. Load companion-replies first on companion channels.
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, maps, replies, formatting, travel]
    related_skills: [companion-replies, companion-user-location, companion-markdown-blocks, companion-links]
---

# Companion Map Preview

## Overview

The companion app parses assistant replies into sibling root-level blocks. Use this skill when replying on a companion channel and the user should see a native map preview for a place or route inside the chat bubble.

Wrap map data in a fenced `map` block — open with ` ```map ` on its own line; close with ` ``` ` on its own line.

## Block rules

- A reply may contain normal text, root-level `markdown` blocks, and root-level `map` blocks in any order. See `companion-markdown-blocks` for formatted text.
- Each `map` block represents exactly one map item.
- Supported map block types: `place` and `route`.
- If including a map link, put it **outside** the `map` block as normal message text. See `companion-links` for tappable link formatting.
- Do not emit a `map` block unless the coordinates are known.
- For routes, always provide explicit coordinates for `origin`, `destination`, and any `waypoints`.
- If the data is incomplete or uncertain, describe it in plain text instead of emitting a broken `map` block.

## Place format

````text
```map
type: place
title: Time Out Market
subtitle: Lunch option
coordinate:
  latitude: 38.7077
  longitude: -9.1454
```
````

## Rendering from LocationRecord

When `companion-user-location` returns a LocationRecord, map fields as follows:

| LocationRecord field | Map field |
|---------------------|-----------|
| `address` (when resolved) or `"Current location"` | `title` |
| `accuracy_m` + `freshness`; note if `address_status: pending` | `subtitle` |
| `lat` / `lon` | `coordinate.latitude` / `coordinate.longitude` |

Rules:

- If `available: false` — do not emit a map block; plain text per `companion-replies`.
- If coordinates are stale, say so in `subtitle`; do not invent fresher coordinates.
- Apple Maps link stays outside fence via `companion-links`.

## Route format

````text
```map
type: route
title: Walk to dinner
transport: walking
origin:
  name: Hotel
  latitude: 38.7223
  longitude: -9.1393
destination:
  name: Cervejaria Ramiro
  latitude: 38.7209
  longitude: -9.1342
waypoints:
  - name: Miradouro de Santa Luzia
    latitude: 38.7119
    longitude: -9.1302
```
````

Valid `transport` values:

- `walking`
- `driving`
- `transit`
- `cycling`

## Example full reply

````text
Here's the walking route.

```map
type: route
title: Walk to dinner
transport: walking
origin:
  name: Hotel
  latitude: 38.7223
  longitude: -9.1393
destination:
  name: Cervejaria Ramiro
  latitude: 38.7209
  longitude: -9.1342
```

[Open in Apple Maps](https://maps.apple.com/?saddr=38.7223,-9.1393&daddr=38.7209,-9.1342&dirflg=w)
````

## Do not

- Nest `map` inside `markdown`
- Put URLs inside the `map` block
- Omit required coordinates
- Invent approximate coordinates when they are not known

## Related skills

- `companion-replies` — entry point for companion reply formatting
- `companion-user-location` — data skill for vault coordinates; use its LocationRecord when rendering a `type: place` preview or when a route origin is "here"
- `companion-markdown-blocks` — rich formatted content as sibling root-level blocks
- `companion-links` — tappable URLs in plain message text