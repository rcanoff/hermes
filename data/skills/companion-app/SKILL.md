---
name: companion-app
description: REQUIRED entry point for Companion App replies. iOS bootstrap tells Hermes to load this skill first. Routes intents to reply, block, and data skills. Does not own fence syntax.
version: 1.2.9
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, index, routing, mobile]
    related_skills: [companion-replies, companion-reminders, companion-maps, companion-cron, companion-user-location, companion-user-health, companion-map-preview, companion-links, companion-markdown-blocks, web-search-result-extraction, obsidian]
---

# Companion App

## Overview

Entry point for the assistant-companion iOS channel. The client bootstrap prompt instructs Hermes to call `skill_view(name='companion-app')` before composing a reply.

This skill routes by intent. It does **not** define block syntax — delegate to child skills.

Operator tasks (invites, password resets) use `companion-account-management` directly; do not route them from here.

## Language

**Always reply in English** on the Companion App channel — even if the user writes in German. Do not switch to German for now.

## Team jobs

The roster lists each bot’s **jobs** (`responsibilities`), never soul.

**Any** bot may call companion MCP `message_teammate` with a teammate’s name. Do not message yourself.

If a teammate’s jobs match the user’s request, the **main** assistant MUST call `message_teammate` with their name and the request. Do not do that job yourself — no vault, notes, memory, or terminal for their jobs.

If `message_teammate` is not in your current tool list, call `tool_search("message_teammate")` then call it.

If your own jobs are not set yet, ask 2–3 short questions, then call `set_my_responsibilities`. Do not do specialist work until jobs are set.

## Reply composition

Do not write user-facing text before or between tool calls. After tools finish, load `companion-replies` and compose the answer there. All user-facing text must be English (see **Language** above).

## Intent routing

| User intent | Load (in order) | Notes |
|-------------|-----------------|-------|
| Short text answer | `companion-replies` | Plain text only |
| Rich layout (list, table, headings) | `companion-replies` → `companion-markdown-blocks` | |
| Show a place on map (coordinates known) | `companion-replies` → `companion-map-preview` | Coordinates already in context |
| Show a place on map (search / geocode) | `companion-maps` → `companion-replies` → `companion-map-preview` | Resolve place via `maps_*` first |
| Share tappable URL | `companion-replies` → `companion-links` | URLs outside `map` fences |
| "Where am I?" / current position | `companion-maps` → `companion-replies` → `companion-map-preview` | iPhone vault via **apple** MCP — not Mac GPS |
| Navigate / directions / route to X | `companion-maps` → `companion-replies` → `companion-map-preview` (+ optional `companion-links`) | Omit origin for "here" / "me" |
| ETA / travel time / distance | `companion-maps` → `companion-replies` | `maps_travel_time`, `maps_distance`, or route tools |
| Nearby POI (pharmacy, coffee, gas, …) | `companion-maps` → `companion-replies` → `companion-map-preview` or `companion-markdown-blocks` | "Near me" uses iPhone location |
| Search or geocode a place by name / address | `companion-maps` → `companion-replies` | Fixed address — header optional |
| Open in Apple Maps (handoff) | `companion-maps` → `companion-replies` → `companion-links` | iPhone URL via `companion-links` only — not `maps_open_*` unless user explicitly wants Mac Maps |
| Geofence / alert when I arrive or leave | `companion-replies` | **Out of scope** — deferred to Companion iOS |
| Location history | `companion-user-location` → `companion-replies` → plain text or `companion-markdown-blocks` | Vault history — not live MapKit routing |
| Steps / activity today | `companion-user-health` → `companion-replies` | Fetch data first |
| Steps to goal / ring progress | `companion-user-health` → `companion-replies` (optional `companion-markdown-blocks`) | Note `partial` + `synced_at` staleness |
| Health history ("steps last Tuesday") | `companion-user-health` → plain text or `companion-markdown-blocks` | Use `get_user_health_daily` or history |
| Sleep / rest questions | `companion-user-health` → `companion-replies` | Fetch data first |
| Heart rate / HRV | `companion-user-health` → `companion-replies` | Fetch data first |
| Workouts today / this week | `companion-user-health` → `companion-replies` (optional `companion-markdown-blocks`) | Fetch data first |
| Weight / body composition | `companion-user-health` → `companion-replies` | Fetch data first |
| Nutrition / water / protein | `companion-user-health` → `companion-replies` | Fetch data first |
| Mindfulness / meditation | `companion-user-health` → `companion-replies` | Fetch data first |
| Tasks, todos, shopping lists, reminders, what's due | `companion-reminders` → `companion-replies` | Apple Reminders via **apple** MCP (`reminders_*` tools) — one-shot capture/query/complete; not scheduled cron |
| Mark done / check off / move / delete reminder | `companion-reminders` → `companion-replies` | |
| List management (create, rename, delete lists) | `companion-reminders` → `companion-replies` | |
| Remind me / run every day / cron / job | `companion-cron` (load first, follow exactly) | Scheduled/deferred jobs only — not one-shot Apple Reminders; MCP create/link + `cronjob` with `deliver: local` — never `origin` |
| Site search / listing links (ImmoScout, Kleinanzeigen, etc.) | `web-search-result-extraction` → `companion-replies` → `companion-links` | ImmoScout: `immoscout-apartment-search`. Kleinanzeigen/Nachmieter: same reply shape; see `references/kleinanzeigen-rental-extraction.md` |
| Where to buy X locally (shops, butchers, no named site) | `web-search-result-extraction` → `companion-replies` → `companion-links` | See `references/local-retail-product-hunt.md`; verify on each merchant site |
| Create / save / write / append a note | `obsidian` → `companion-replies` | "create a note with…", "save this to a note", "write a note", append to vault, etc. Vault writes use `/opt/data/vault` only (`OBSIDIAN_VAULT_PATH` in container) — never host macOS iCloud paths, never `/opt/data/notes/` |

## Note saving

When the user asks to create, save, write, or append a note, load `obsidian` first and follow its vault workflow. Confirm with `companion-replies` after the write succeeds. All vault paths must resolve to `/opt/data/vault` inside the container — do not use the host iCloud path or `/opt/data/notes/`.

If the user says **“fix it”** immediately after vault/Obsidian access failed, treat that as **fix the vault mount** (`/opt/data/vault` symlink, `OBSIDIAN_VAULT_PATH`, iCloud sync) — not flight search, fares, or unrelated browser tasks. Load `hermes-obsidian-vault` with `obsidian`.

## Data → present pipeline (required)

For any vault data intent (live maps, location history, health):

| Phase | What to do | Skills |
|-------|------------|--------|
| **GET** | Call MCP, normalize to a record | `companion-maps` (live position, search, route, ETA), `companion-user-location` (history), `companion-user-health`, … |
| **PRESENT** | Load reply + block skills | `companion-replies` → `companion-map-preview` / `companion-markdown-blocks` / `companion-links` |
| **REPLY** | Compose user-facing text from the record | per child skills |

**GET alone is never enough.** If you have vault data but have not loaded `companion-replies`, do not send a reply yet.

## Workflow

1. Parse user intent from the message.
2. **GET** — if vault data is needed, load the data skill, call MCP, normalize to a record. Do not format the answer here.
3. **PRESENT** — load `companion-replies`, then only the block skills the reply needs.
4. **REPLY** — after tools finish, compose sibling parts (plain text, blocks, links) from the record via `companion-replies`.

## Do not

- Write user-facing text before or between tool calls
- Narrate tools (“I’ll pull”, “Loading …”, “Next I’ll”, “Pausing … now”, “Removing … now”)
- Repeat what the gear already shows (`skill_view`, `cronjob`, MCP names)
- Use Todoist — Reminders is the task backend
- Call `session_search` — disabled on the Companion App channel; use messages in **this** conversation only
- Call `cronjob` for companion reminders without loading `companion-cron` and completing the MCP create/link flow
- Use `deliver: origin` (or omit `deliver`) for companion cron jobs — that delivers to Telegram
- Write cron prompts that say "send" / "notify" / "message the user" — follow `companion-cron`: self-contained output prompt, context resolved from chat
- Send a reply after a data skill without loading `companion-replies`
- Format location or health answers inside data skills
- Duplicate fence syntax from `companion-map-preview`, `companion-links`, or `companion-markdown-blocks`
- Use `companion-user-location` for MapKit search, routing, ETA, or "where am I?" — use `companion-maps` (`maps_*` on **apple** MCP)
- Call Home Assistant for companion user location
- Route account invites from this skill
- Save notes outside the Obsidian vault path (`/opt/data/vault`) — never host iCloud paths or `/opt/data/notes/`
- Reply in German — English only on this channel for now