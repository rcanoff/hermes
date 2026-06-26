---
name: companion-reminders
description: Task and list skill — capture, query, complete, and manage Apple Reminders via the reminders MCP. Use for todos, shopping lists, due-date queries, and list CRUD. Not for rich notes (Obsidian) or scheduled cron jobs (companion-cron).
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, reminders, tasks, lists, mcp, mobile]
    related_skills: [companion-app, companion-replies, companion-cron, obsidian]
---

# Companion Reminders

## Protected lists

Operator-editable policy only — MCP does **not** enforce these. Do not create, rename, delete, or bulk-modify reminders on protected lists unless the user explicitly asks for a specific item by name.

- Personal
- Family

## Overview

Apple Reminders is the task backend for the Companion App. Use the **`reminders`** MCP server (`host.docker.internal`) for all task/list work.

- **Capture** — add items to a list
- **Query** — what's due, overdue, or on a named list
- **Complete** — mark done or undo
- **List management** — create, rename, delete lists; move items between lists

Reminders sync to iPhone and Mac via iCloud. Prefer **list names** (not ids) in user-facing replies.

## When to use

- "add … to my shopping list", "remind me to …", "put milk on Shopping"
- "what's due today?", "what's overdue?", "show my todos"
- "mark X done", "complete …", "check off …"
- "create a list called …", "rename … list", "delete … list"
- "move … to … list", "what's on the Groceries list?"

**Not this skill:**

- **Scheduled / recurring chat reminders** → `companion-cron` (Hermes cron + job conversation)
- **Long-form notes, links, prices, research** → `obsidian` (vault writes)
- **Calendar events** → `apple_calendar` MCP

## Hard rules

- **Prefer list names over ids** in replies — e.g. "added to **Shopping**", not "list `abc123`".
- **Do not set** notes, alarms, priority, location, recurrence, subtasks, or attachments — v1 MCP does not expose them; use Obsidian for rich content.
- **Protected lists** — avoid writes unless the user names a specific reminder; never bulk-delete or rename protected lists without explicit confirmation.
- **Shopping / grocery lists** are normal Reminders lists — treat "groceries", "shopping", and named lists like **Shopping** the same as any other list.
- After MCP calls, load `companion-replies` before sending the user-facing message.

## Tools (reminders MCP)

### Lists

| Tool | Use when |
|------|----------|
| `list_lists` | Discover lists; resolve a name before create/move |
| `create_list` | User wants a new list by name |
| `rename_list` | Rename by id or current name |
| `delete_list` | Delete by id or name — confirm if list may have items; skip protected lists unless explicit |

### Reminders

| Tool | Use when |
|------|----------|
| `list_reminders` | Query by list, completion, or due date |
| `get_reminder` | Single item by id after a list query |
| `create_reminder` | Add item: `title`, optional `due` (ISO 8601), optional `list` (name or id) |
| `update_reminder` | Change `title`, `due`, `list`, or `completed` only |
| `complete_reminder` | Mark done |
| `uncomplete_reminder` | Mark not done |
| `delete_reminder` | Remove item |
| `move_reminder` | Change list |

## Intent routing

| User intent | MCP tool(s) | Notes |
|-------------|-------------|-------|
| Add / capture / remember | `list_lists` (if list unclear) → `create_reminder` | Default list if user omits one: ask or use a sensible match (e.g. Shopping for groceries) |
| What's due / today / overdue | `list_reminders` | Use `overdue_only`, `due_before`, `due_after` — see **Due-date queries** |
| Show list contents | `list_reminders` with `list` | Omit `completed` or set per user ask |
| Mark done / check off | `list_reminders` or `get_reminder` → `complete_reminder` | Match by title if id unknown |
| Undo complete | `uncomplete_reminder` | |
| Change title or due date | `update_reminder` | Due only — no alarms |
| Move to another list | `move_reminder` or `update_reminder` (`list`) | |
| Delete reminder | `delete_reminder` | Confirm on protected lists |
| New / rename / delete list | `create_list`, `rename_list`, `delete_list` | Respect **Protected lists** |

## Due-date queries

For "what's due today?", "this week?", or "what's overdue?":

1. Call `list_reminders` with filters — do not fetch all reminders and filter in prose.
2. Use **`overdue_only: true`** for overdue items.
3. Use **`due_before`** / **`due_after`** (ISO 8601) for date windows — e.g. end of today for "due today".
4. Set **`completed: false`** unless the user asks for completed items.
5. Group results by list **name** in the reply.

## Workflow

1. Parse intent (capture, query, complete, list admin).
2. If list name is ambiguous, call `list_lists` and pick the best match; say which list you used.
3. Call the appropriate `reminders` MCP tool(s).
4. Load `companion-replies` and confirm in plain English with list **names**, not ids.

## Examples

### "Add milk to Shopping"

1. `list_lists` — confirm **Shopping** exists (or `create_list` if user asked for a new list).
2. `create_reminder` with `title: "milk"`, `list: "Shopping"`.
3. Reply: "Added **milk** to **Shopping**."

### "What's due today?"

1. `list_reminders` with `completed: false`, `due_after` = start of today, `due_before` = end of today (operator timezone).
2. Optionally `list_reminders` with `overdue_only: true` if user also wants overdue called out.
3. Reply with items grouped by list name; mention if nothing is due.

### "Mark buy flowers done"

1. `list_reminders` with `completed: false` and search across lists, or filter by list if user named one.
2. Match "buy flowers" (fuzzy title match); `complete_reminder` with matched id.
3. Reply: "Marked **buy flowers** done on **Errands**." (use actual list name)

## Do not

- Use Todoist — Reminders is the task backend
- Set notes, alarms, priority, or recurrence on reminders
- Expose raw reminder or list ids in user-facing text unless debugging at operator request
- Bulk-modify or delete **Protected lists** without explicit user confirmation
- Route scheduled "remind me every day at 9" to this skill — use `companion-cron`
- Save long research, links, or prices into reminder notes — use `obsidian`