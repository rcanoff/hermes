---
name: companion-app
description: REQUIRED entry point for Companion App replies. iOS bootstrap tells Hermes to load this skill first. Routes intents to reply, block, and data skills. Does not own fence syntax.
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, index, routing, mobile]
    related_skills: [companion-replies, companion-user-location, companion-user-health, companion-map-preview, companion-links, companion-markdown-blocks]
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
| Route / directions | `companion-user-location` (if origin is "here") → `companion-map-preview` (+ optional `companion-links`) | |
| Location history | `companion-user-location` → plain text or `companion-markdown-blocks` | Map only if user asks to see a place |
| Steps / activity today | `companion-user-health` → `companion-replies` | Fetch data first |
| Steps to goal / ring progress | `companion-user-health` → `companion-replies` (optional `companion-markdown-blocks`) | Note `partial` + `synced_at` staleness |
| Health history ("steps last Tuesday") | `companion-user-health` → plain text or `companion-markdown-blocks` | Use `get_user_health_daily` or history |

## Workflow

1. Parse user intent from the message.
2. Load data skills if the answer needs vault data.
3. Load `companion-replies`, then only the block skills the reply needs.
4. Compose sibling parts — plain text, blocks, links — per child skills.

## Do not

- Duplicate fence syntax from `companion-map-preview`, `companion-links`, or `companion-markdown-blocks`
- Call Home Assistant for companion user location
- Route account invites from this skill