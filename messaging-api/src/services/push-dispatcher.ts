import type Database from 'better-sqlite3'
import type { ApnsConfig } from '../config.js'
import {
  deletePushDeviceById,
  listPushDevicesByUserId,
} from '../db/repos/push-devices.js'
import { buildChatPushAlert, buildJobPushAlert } from '../lib/push-preview.js'
import type { StreamHub } from '../streams/hub.js'
import type { ApnsClient } from './apns-client.js'

type PushKind = 'assistant_reply' | 'cron_run'
type PushDestination = 'conversation' | 'jobs'

interface DispatchInput {
  db: Database.Database
  hub: StreamHub | null
  apns: ApnsClient
  config: ApnsConfig
  userId: string
  conversationId: string
  messageId: string
  kind: PushKind
  destination: PushDestination
  threadId: string
  buildAlert: () => { title: string; body: string }
  log?: (message: string, meta?: Record<string, unknown>) => void
}

async function dispatchToDevices(input: DispatchInput): Promise<void> {
  if (!input.config.enabled) {
    return
  }

  if (input.hub?.hasUserSessionListener(input.userId)) {
    return
  }

  const devices = listPushDevicesByUserId(input.db, input.userId)
  const alert = input.buildAlert()
  const payload = {
    aps: {
      alert: {
        title: alert.title,
        body: alert.body,
      },
      sound: 'default',
      'thread-id': input.threadId,
    },
    companion: {
      destination: input.destination,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      kind: input.kind,
    },
  }

  await Promise.all(
    devices.map(async (device) => {
      const result = await input.apns.send({
        deviceToken: device.device_token,
        environment: device.environment,
        payload,
      })

      if (!result.ok && result.unregistered) {
        deletePushDeviceById(input.db, device.id)
        return
      }

      if (!result.ok) {
        input.log?.('apns send failed', {
          deviceId: device.id,
          status: result.status,
          reason: result.reason,
        })
      }
    }),
  )
}

export async function notifyCommittedAssistantMessage(input: {
  db: Database.Database
  hub: StreamHub
  apns: ApnsClient
  config: ApnsConfig
  userId: string
  conversationId: string
  messageId: string
  content: string
  conversationTitle: string | null
  log?: (message: string, meta?: Record<string, unknown>) => void
}): Promise<void> {
  await dispatchToDevices({
    db: input.db,
    hub: input.hub,
    apns: input.apns,
    config: input.config,
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    kind: 'assistant_reply',
    destination: 'conversation',
    threadId: input.conversationId,
    buildAlert: () =>
      buildChatPushAlert({
        title: input.conversationTitle,
        content: input.content,
        maxChars: input.config.previewMaxChars,
      }),
    log: input.log,
  })
}

export async function notifyCommittedCronMessage(input: {
  db: Database.Database
  hub: StreamHub
  apns: ApnsClient
  config: ApnsConfig
  userId: string
  conversationId: string
  messageId: string
  content: string
  conversationTitle: string | null
  scheduleDisplay?: string | null
  log?: (message: string, meta?: Record<string, unknown>) => void
}): Promise<void> {
  await dispatchToDevices({
    db: input.db,
    hub: input.hub,
    apns: input.apns,
    config: input.config,
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    kind: 'cron_run',
    destination: 'jobs',
    threadId: 'jobs',
    buildAlert: () =>
      buildJobPushAlert({
        title: input.conversationTitle,
        content: input.content,
        scheduleDisplay: input.scheduleDisplay,
        maxChars: input.config.previewMaxChars,
      }),
    log: input.log,
  })
}