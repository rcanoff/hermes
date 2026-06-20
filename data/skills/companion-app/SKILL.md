---
name: companion-app
description: REQUIRED entry point for Companion App replies. iOS bootstrap tells Hermes to load this skill first. Routes intents to reply, block, and data skills. Does not own fence syntax.
version: 1.2.0
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, index, routing, mobile]
    related_skills: [companion-replies, companion-cron, companion-user-location, companion-user-health, companion-map-preview, companion-links, companion-markdown-blocks]
---

# Companion App

## Overview

Entry point for the assistant-companion iOS channel. The client bootstrap prompt instructs Hermes to call `skill_view(name='companion-app')` before composing a reply.

This skill routes by intent. It does **not** define block syntax — delegate to child skills.

Operator tasks (invites, password resets) use `companion-account-management` directly; do not route them from here.

## Reply composition

Before writing any Companion App reply, load `companion-replies` and follow its reply model.

## Intent routing

| User intent | Load (in order) | Notes |
|-------------|-----------------|-------|
| Short text answer | `companion-replies` | Plain text only |
| Rich layout (list, table, headings) | `companion-replies` → `companion-markdown-blocks` | |
| Show a place on map | `companion-replies` → `companion-map-preview` | Known coordinates required |
| Share tappable URL | `companion-replies` → `companion-links` | URLs outside `map` fences |
| "Where am I?" / current position | `companion-user-location` → `companion-replies` → `companion-map-preview` | Fetch data first |
| Route / directions | `companion-user-location` (if origin is "here") → `companion-replies` → `companion-map-preview` (+ optional `companion-links`) | |
| Location history | `companion-user-location` → `companion-replies` → plain text or `companion-markdown-blocks` | Map only if user asks to see a place |
| Steps / activity today | `companion-user-health` → `companion-replies` | Fetch data first |
| Steps to goal / ring progress | `companion-user-health` → `companion-replies` (optional `companion-markdown-blocks`) | Note `partial` + `synced_at` staleness |
| Health history ("steps last Tuesday") | `companion-user-health` → plain text or `companion-markdown-blocks` | Use `get_user_health_daily` or history |
| Sleep / rest questions | `companion-user-health` → `companion-replies` | Fetch data first |
| Heart rate / HRV | `companion-user-health` → `companion-replies` | Fetch data first |
| Workouts today / this week | `companion-user-health` → `companion-replies` (optional `companion-markdown-blocks`) | Fetch data first |
| Weight / body composition | `companion-user-health` → `companion-replies` | Fetch data first |
| Nutrition / water / protein | `companion-user-health` → `companion-replies` | Fetch data first |
| Mindfulness / meditation | `companion-user-health` → `companion-replies` | Fetch data first |
| Remind me / run every day / cron / job | `companion-cron` (load first, follow exactly) | MCP create/link + `cronjob` with `deliver: local` — never `origin` |

## Data → present pipeline (required)

For any vault data intent (location, health):

| Phase | What to do | Skills |
|-------|------------|--------|
| **GET** | Call MCP, normalize to a record | `companion-user-location`, `companion-user-health`, … |
| **PRESENT** | Load reply + block skills | `companion-replies` → `companion-map-preview` / `companion-markdown-blocks` / `companion-links` |
| **REPLY** | Compose user-facing text from the record | per child skills |

**GET alone is never enough.** If you have vault data but have not loaded `companion-replies`, do not send a reply yet.

## Workflow

1. Parse user intent from the message.
2. **GET** — if vault data is needed, load the data skill, call MCP, normalize to a record. Do not format the answer here.
3. **PRESENT** — load `companion-replies`, then only the block skills the reply needs.
4. **REPLY** — compose sibling parts (plain text, blocks, links) from the record.

## Do not

- Call `cronjob` for companion reminders without loading `companion-cron` and completing the MCP create/link flow
- Use `deliver: origin` (or omit `deliver`) for companion cron jobs — that delivers to Telegram
- Write cron prompts that say "send" / "notify" / "message the user" — use `companion-cron` literal-output reminder templates (`Reminder: …`, no tools)
- Send a reply after a data skill without loading `companion-replies`
- Format location or health answers inside data skills
- Duplicate fence syntax from `companion-map-preview`, `companion-links`, or `companion-markdown-blocks`
- Call Home Assistant for companion user location
- Route account invites from this skill