# Cross-Platform Messaging Session Routing Idea

**Date:** 2026-06-11  
**Status:** Archived (idea — not implemented)

## Goal

Reduce Telegram noise while preserving access to Hermes tool progress and session context on another messaging platform such as Slack or Discord.

## Idea

Use Telegram as the primary user-facing chat with low verbosity, and use Slack or Discord as an alternate platform for the same Hermes conversation when richer progress visibility is needed.

## What Hermes Supports

- Different messaging platforms are separate sessions by default.
- Hermes can move a live conversation between platforms with `/handoff <platform>`.
- A handoff keeps the same session ID, transcript, and tool history.
- Slack and Discord support thread-based handoff targets.
- Telegram can also receive a handoff target through its home channel/topic model.

## Important Limitation

Hermes does not natively split one live conversation so that:

- tool progress goes to Slack or Discord
- final answers go to Telegram

for the same turn at the same time.

In practice, Hermes moves the session between platforms rather than mirroring one session across multiple platforms simultaneously.

## Proposed Workflow

1. Keep Telegram as the normal chat surface.
2. Configure Telegram to be quiet:
   - `display.platforms.telegram.tool_progress: off`
   - `display.interim_assistant_messages: false`
   - optionally `display.platforms.telegram.cleanup_progress: true`
3. Configure Slack or Discord to be more verbose:
   - `display.platforms.slack.tool_progress: verbose`
   - or `display.platforms.discord.tool_progress: verbose`
4. When detailed live progress is needed, hand the session off from CLI or an existing active surface to Slack or Discord with `/handoff slack` or `/handoff discord`.
5. Continue the same conversation there with full session continuity.

## Expected Outcome

- Telegram stays clean for normal use.
- Slack or Discord becomes the better place for inspecting live tool activity.
- Session continuity is preserved when using handoff.
- No custom routing or multi-bot split is required.

## Open Question

If a true split-view workflow is required later, the next option to evaluate is a second Hermes profile or bot dedicated to operator-facing logs, but that would be a separate architecture from Hermes' normal single-session messaging model.
