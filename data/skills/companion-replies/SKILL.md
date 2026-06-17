---
name: companion-replies
description: Reply composition model for Companion App and related channels. Loaded via companion-app on iOS; delegate to block skills for maps, markdown, and links.
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, replies, formatting]
    related_skills: [companion-app, companion-markdown-blocks, companion-map-preview, companion-links]
---

# Companion Replies

## Overview

On the **Companion App**, the client parses each assistant reply into **sibling parts**: plain text plus optional root-level blocks. The iOS bootstrap loads `companion-app` first; that index skill routes here for reply composition.

`messaging-api` sends `X-Hermes-Session-Key: companion-app` on every Hermes call. Hermes may still log the internal platform id `api_server`; treat Companion App bootstrap context as authoritative for reply formatting.

Do not invent block syntax here. Load the block skill that matches what the reply needs.

## When to use

- `companion-app` routed you here for reply composition (typical on assistant-companion iOS via `messaging-api` → Hermes).
- The turn includes Companion App bootstrap context, or the task is clearly a mobile companion reply (map preview, markdown block, tappable link).
- Do **not** use this skill for Telegram, CLI, or other Hermes platforms unless the user explicitly wants companion-style blocks there.

## Reply model

A single reply may mix, in any order:

| Part | How Hermes writes it | Skill |
|------|----------------------|-------|
| Plain text | Normal sentences | — |
| Formatted section | ` ```markdown ` … ` ``` ` | `companion-markdown-blocks` |
| Map preview | ` ```map ` … ` ``` ` | `companion-map-preview` |
| Tappable URL | `[label](url)` or full `https://…` in plain text | `companion-links` |

Blocks are **siblings** — never nest `map` inside `markdown`, and never put URLs inside `map`.

## Which skill to use

| User need | Follow |
|-----------|--------|
| Short answer, no special rendering | Plain text only — no block skill |
| List, table, headings, rich layout | `companion-markdown-blocks` |
| Show a place or route on a native map preview | `companion-map-preview` |
| Share a URL to open (maps, article, menu, etc.) | `companion-links` |
| Route with preview **and** open-in-Maps link | `companion-map-preview` + `companion-links` |
| Formatted options **and** a map for one of them | `companion-markdown-blocks` + `companion-map-preview` |

## Common combinations

### Route with map preview and link

1. Brief plain-text intro
2. `map` block (`type: route`) — `companion-map-preview`
3. Map link outside the fence — `companion-links`

### Location answer

1. Load `companion-user-location` — fetch vault data and normalize to a LocationRecord.
2. Companion App + `available: true` → brief context if needed, then a `type: place` map block via `companion-map-preview` (accuracy/freshness in `subtitle`). Optional Apple Maps link via `companion-links`.
3. Companion App + `available: false` → plain text only (suggest sharing location from the app).
4. Other channels → plain-text four-line format (no map blocks):

   ```text
   Address: ...
   Coordinates: lat, lon
   Accuracy: Xm
   Updated: 12 min ago
   ```

   Omit the address line when `address_status: pending`.

### Operator tasks (not reply formatting)

Account invites and password resets use `companion-account-management` — not this skill.

## Workflow

1. Decide what the user should see: text only, formatted layout, map preview, link, or a combination.
2. Load only the block skills you need.
3. Compose the reply with sibling parts — plain text, then blocks, then more plain text as needed.
4. Verify each block uses the correct fence (`markdown` or `map`) and that links stay outside `map` blocks.

## Do not

- Duplicate block syntax from child skills — read the relevant one
- Nest blocks inside other blocks
- Strip or shorten URLs — `companion-links`
- Emit a `map` block without known coordinates — `companion-map-preview`

## Parent and block skills

- `companion-app` — index skill; bootstrap entry on Companion App
- `companion-markdown-blocks` — fenced `markdown` sections
- `companion-map-preview` — fenced `map` sections (`place`, `route`)
- `companion-links` — tappable URLs in plain text (or inside markdown)

## Related data skills

- `companion-user-location` — operator location from the vault
- `companion-account-management` — invites and password resets