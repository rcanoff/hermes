import type { ToolingLine } from '../db/repos/process.js'
import type { StreamHub } from './hub.js'

export interface RunEventContext {
  hub: StreamHub
  userId: string
  conversationId: string
  runId: string
  originSessionId: string | null
  legacyStreamEnabled?: boolean
}

function toolingLinePayload(ctx: RunEventContext, line: ToolingLine) {
  return {
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    phase: line.phase,
    text: line.text,
    ...(line.tool != null ? { tool: line.tool } : {}),
    ...(line.args != null ? { args: line.args } : {}),
  }
}

export function publishToolingDraft(ctx: RunEventContext, text: string): void {
  ctx.hub.publishToUser(ctx.userId, {
    event: 'tooling',
    data: {
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      phase: 'reasoning',
      text,
      draft: true,
    },
  })
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, {
      event: 'process_token',
      data: { phase: 'reasoning', text },
    })
  }
}

export function publishToolingLine(ctx: RunEventContext, line: ToolingLine): void {
  const payload = toolingLinePayload(ctx, line)
  ctx.hub.publishToUser(ctx.userId, {
    event: 'tooling',
    data: payload,
  })
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'process', data: line })
  }
}

export function publishToolingComplete(ctx: RunEventContext): void {
  ctx.hub.publishToUser(ctx.userId, {
    event: 'tooling',
    data: {
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      phase: 'complete',
    },
  })
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'process_complete', data: {} })
  }
}

export function publishReplyToken(ctx: RunEventContext, text: string): void {
  ctx.hub.publishToUser(ctx.userId, {
    event: 'reply',
    data: { conversationId: ctx.conversationId, runId: ctx.runId, text },
  })
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'token', data: { text } })
  }
}

export function publishReplyDone(ctx: RunEventContext, messageId: string): void {
  ctx.hub.publishToUser(ctx.userId, {
    event: 'reply',
    data: {
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      phase: 'done',
      messageId,
    },
  })
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'done', data: { messageId } })
  }
}

export function publishRunError(ctx: RunEventContext, code: string): void {
  ctx.hub.publishToUser(ctx.userId, {
    event: 'error',
    data: { conversationId: ctx.conversationId, runId: ctx.runId, code },
  })
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'error', data: { code } })
  }
}

export function publishRewind(
  ctx: RunEventContext,
  removedMessageIds: string[],
): void {
  ctx.hub.publishToUser(ctx.userId, {
    event: 'rewind',
    data: {
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      removedMessageIds,
    },
  })
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.setPendingRewind(ctx.conversationId, removedMessageIds)
    ctx.hub.publishLegacy(ctx.conversationId, {
      event: 'rewind',
      data: { removedMessageIds },
    })
  }
}

export function publishSessionTitle(
  hub: StreamHub,
  userId: string,
  conversationId: string,
  title: string,
  legacyStreamEnabled = true,
): void {
  hub.publishToUser(userId, {
    event: 'title',
    data: { conversationId, title },
  })
  if (legacyStreamEnabled) {
    hub.publishLegacy(conversationId, { event: 'title', data: { title } })
  }
}