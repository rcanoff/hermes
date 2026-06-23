import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  isCronOutputDelivered,
  markCronOutputDelivered,
} from '../db/repos/cron-output-bridge.js'
import { deliverCronRun } from '../db/repos/cron-deliver.js'
import { findConversationByHermesJobId } from '../db/repos/conversations.js'
import {
  parseCronOutputFilenameTimestamp,
  parseCronOutputMarkdown,
  parseCronOutputPath,
  parseCronRunTimeString,
} from '../lib/cron-output.js'
import { loadCronRunProcessLines } from './cron-session-process.js'
import type { PushNotificationService } from './push-notifications.js'

export interface CronOutputBridgeOptions {
  db: Database.Database
  outputDir: string
  hermesStateDbPath?: string
  pollMs?: number
  pushNotifications?: PushNotificationService
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export class CronOutputBridge {
  private timer: NodeJS.Timeout | undefined
  private polling = false

  constructor(private readonly options: CronOutputBridgeOptions) {}

  start(): void {
    if (this.timer) {
      return
    }

    const pollMs = this.options.pollMs ?? 5_000
    void this.poll()
    this.timer = setInterval(() => {
      void this.poll()
    }, pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) {
      return
    }

    clearInterval(this.timer)
    this.timer = undefined
  }

  async poll(): Promise<void> {
    if (this.polling) {
      return
    }

    this.polling = true
    try {
      await this.scanOutputDirectory()
    } catch (error) {
      this.log('cron output bridge poll failed', {
        err: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.polling = false
    }
  }

  private async scanOutputDirectory(): Promise<void> {
    const outputDir = this.options.outputDir
    let jobEntries: Array<{ name: string; isDirectory: () => boolean }>

    try {
      jobEntries = await readdir(outputDir, { withFileTypes: true })
    } catch (error) {
      if (isMissingDirectoryError(error)) {
        return
      }
      throw error
    }

    for (const jobEntry of jobEntries) {
      if (!jobEntry.isDirectory()) {
        continue
      }

      const jobDir = join(outputDir, jobEntry.name)
      const files = await readdir(jobDir, { withFileTypes: true })
      for (const fileEntry of files) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.md')) {
          continue
        }

        const absolutePath = join(jobDir, fileEntry.name)
        await this.processOutputFile(absolutePath)
      }
    }
  }

  private async processOutputFile(absolutePath: string): Promise<void> {
    const parsedPath = parseCronOutputPath(this.options.outputDir, absolutePath)
    if (!parsedPath) {
      return
    }

    if (isCronOutputDelivered(this.options.db, parsedPath.relativePath)) {
      return
    }

    const conversation = findConversationByHermesJobId(
      this.options.db,
      parsedPath.hermesJobId,
    )
    if (!conversation) {
      return
    }

    const raw = await readFile(absolutePath, 'utf8')
    const parsed = parseCronOutputMarkdown(raw)
    if (!parsed) {
      return
    }

    const completedAt = resolveCronCompletedAt(parsed.runAt, parsedPath.filename)
    const processLines = completedAt
      ? loadCronRunProcessLines({
          hermesStateDbPath: this.options.hermesStateDbPath,
          hermesJobId: parsedPath.hermesJobId,
          completedAt,
        })
      : []

    const result = deliverCronRun(this.options.db, {
      hermesJobId: parsedPath.hermesJobId,
      content: parsed.response,
      status: 'ok',
      runAt: parsed.runAt ?? undefined,
      processLines,
    })

    if (!result) {
      return
    }

    markCronOutputDelivered(
      this.options.db,
      parsedPath.relativePath,
      parsedPath.hermesJobId,
    )

    if (result.kind === 'delivered' && this.options.pushNotifications) {
      void this.options.pushNotifications
        .notifyCronMessage({
          userId: result.userId,
          conversationId: result.conversationId,
          messageId: result.messageId,
          content: result.content,
          conversationTitle: result.title,
          scheduleDisplay: result.scheduleDisplay,
        })
        .catch((error) => {
          this.log('cron output push notification failed', {
            hermesJobId: parsedPath.hermesJobId,
            err: error instanceof Error ? error.message : String(error),
          })
        })
    }

    this.log('delivered companion cron output', {
      hermesJobId: parsedPath.hermesJobId,
      conversationId: conversation.id,
      kind: result.kind,
    })
  }

  private log(message: string, meta?: Record<string, unknown>): void {
    this.options.log?.(message, meta)
  }
}

function resolveCronCompletedAt(runAt: string | null, filename: string): Date | null {
  if (runAt) {
    const fromMarkdown = parseCronRunTimeString(runAt)
    if (fromMarkdown) {
      return fromMarkdown
    }
  }

  return parseCronOutputFilenameTimestamp(filename)
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}