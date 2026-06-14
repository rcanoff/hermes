---
name: companion-account-management
description: Use when the operator asks to create a companion app account, reset a companion password, list companion users, or revoke a pending invite. Calls companion MCP account tools only.
version: 1.0.0
author: Hermes Agent
---

# Companion Account Management

## Tools (companion MCP)

- `create_companion_invite` — optional `label`; returns magic link URL
- `create_password_reset_invite` — requires `username`
- `list_companion_accounts`
- `revoke_companion_invite` — requires `invite_id`

## Rules

- Present the **full** magic link URL verbatim for manual sharing
- Never truncate the token
- Accounts cannot be created except through these MCP tools