import type Database from 'better-sqlite3'
import type { ApnsConfig } from '../config.js'
import type { StreamHub } from '../streams/hub.js'
import type { ApnsClient } from './apns-client.js'
import {
  notifyCommittedAssistantMessage,
  notifyCommittedCronMessage,
} from './push-dispatcher.js'

export class PushNotificationService {
  constructor(
    private readonly db: Database.Database,
    private readonly hub: StreamHub,
    private readonly apns: ApnsClient,
    private readonly config: ApnsConfig,
    private readonly log?: (message: string, meta?: Record<string, unknown>) => void,
  ) {}

  async notifyAssistantMessage(input: {
    userId: string
    conversationId: string
    messageId: string
    content: string
    conversationTitle: string | null
  }): Promise<void> {
    await notifyCommittedAssistantMessage({
      db: this.db,
      hub: this.hub,
      apns: this.apns,
      config: this.config,
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      content: input.content,
      conversationTitle: input.conversationTitle,
      log: this.log,
    })
  }

  async notifyCronMessage(input: {
    userId: string
    conversationId: string
    messageId: string
    content: string
    conversationTitle: string | null
    scheduleDisplay?: string | null
  }): Promise<void> {
    await notifyCommittedCronMessage({
      db: this.db,
      hub: this.hub,
      apns: this.apns,
      config: this.config,
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      content: input.content,
      conversationTitle: input.conversationTitle,
      scheduleDisplay: input.scheduleDisplay,
      log: this.log,
    })
  }
}