import type { ProcessLineKind } from './hub.js'
import type { StreamHub } from './hub.js'

export interface RunEventContext {
  hub: StreamHub
  conversationId: string
  runId: string
  originSessionId: string | null
  legacyStreamEnabled?: boolean
}

export function publishToolingDraft(ctx: RunEventContext, text: string): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'tooling',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        kind: 'reasoning',
        text,
        draft: true,
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, {
      event: 'process_token',
      data: { kind: 'reasoning', text },
    })
  }
}

export function publishToolingLine(
  ctx: RunEventContext,
  line: { kind: ProcessLineKind; text: string },
): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'tooling',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        kind: line.kind,
        text: line.text,
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'process', data: line })
  }
}

export function publishToolingComplete(ctx: RunEventContext): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'tooling',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        phase: 'complete',
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'process_complete', data: {} })
  }
}

export function publishReplyToken(ctx: RunEventContext, text: string): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'reply',
      data: { conversationId: ctx.conversationId, runId: ctx.runId, text },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'token', data: { text } })
  }
}

export function publishReplyDone(ctx: RunEventContext, messageId: string): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'reply',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        phase: 'done',
        messageId,
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'done', data: { messageId } })
  }
}

export function publishRunError(ctx: RunEventContext, code: string): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'error',
      data: { conversationId: ctx.conversationId, runId: ctx.runId, code },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'error', data: { code } })
  }
}

export function publishRewind(
  ctx: RunEventContext,
  removedMessageIds: string[],
): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'rewind',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        removedMessageIds,
      },
    })
  }
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
  originSessionId: string | null,
  conversationId: string,
  title: string,
  legacyStreamEnabled = true,
): void {
  if (originSessionId) {
    hub.publishSession(originSessionId, {
      event: 'title',
      data: { conversationId, title },
    })
  }
  if (legacyStreamEnabled) {
    hub.publishLegacy(conversationId, { event: 'title', data: { title } })
  }
}