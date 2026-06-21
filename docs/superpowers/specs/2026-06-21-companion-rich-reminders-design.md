# Companion Rich Reminders — Design Spec

**Date:** 2026-06-21  
**Status:** Approved  
**API version:** unchanged (no REST/MCP contract change)

## Problem

Companion cron reminders use a one-line literal-output template. When users ask to include a route or map in the reminder, the agent paraphrases ("Route: Berlin to Brussels") instead of copying the `map` block from the conversation. `normalizeCompanionReminderPrompt` can further flatten badly worded prompts to a one-liner derived from the job name.

Observed in the Brussels conversation (2026-06-21): two reminders fired with plain text only despite the user requesting map preview + Apple Maps link.

## Goal

Support **rich reminders** that deliver the same visual reply as a live route answer — brief text, `map` block, and tappable link — while keeping simple one-line reminders unchanged.

## Solution

### 1. Rich literal template

New cron prompt shape for reminders that include blocks:

```
Scheduled reminder only. Your entire response must match the following message exactly (including fences and links). Do not add, remove, or rephrase anything:

<full precomposed reply>

No tools. No other text, steps, or narration.
```

At creation time the agent builds `<full precomposed reply>` from conversation context (via `companion-map-preview` + `companion-links`). The cron agent echoes it verbatim at fire time.

### 2. Skill decision rule

| User request | Template |
|--------------|----------|
| Simple reminder | One-line (existing) |
| Reminder + route / map / link | Rich literal |

Before confirming "done", the agent must verify the cron `prompt` contains a ` ```map ` fence when the user asked for a route. If missing, fix the prompt first.

### 3. Normalization guard

`normalizeCompanionReminderPrompt` skips normalization when:

- Prompt already uses the one-line or rich template prefix
- Prompt body contains a ` ```map ` fence

Naive "send/notify the user" wording is still normalized for simple reminders.

## Files

| File | Change |
|------|--------|
| `data/skills/companion-cron/SKILL.md` | Rich template, decision rule, pre-done validation |
| `messaging-api/src/lib/companion-cron-prompt.ts` | Rich prefix, builder, smarter normalization |
| `messaging-api/test/companion-cron-prompt.test.ts` | Rich template + skip-normalization cases |

## Out of scope

- OpenAPI / REST changes
- Cron runner or output-bridge changes
- Re-fetching live directions at fire time

## Success criteria

Given a route already shown in the conversation, a reminder request that says "add the route" produces a cron prompt containing the exact `map` block and link. At fire time the job conversation receives that full reply, not a paraphrased one-liner.