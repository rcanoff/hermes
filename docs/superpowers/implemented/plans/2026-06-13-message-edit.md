# Message Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `PATCH /conversations/:id/messages/:messageId` edits the latest user message, discards the assistant reply, rotates Hermes session, re-runs.

**Spec:** `docs/superpowers/implemented/specs/2026-06-13-message-edit-design.md`

**Tasks:** repo helpers → rewind event → message-editor service → PATCH route + tests → verify + deploy