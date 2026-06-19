import type Database from 'better-sqlite3'
import {
  createJobConversation,
  findConversationByHermesJobId,
  getConversationForUser,
  linkJobConversation,
} from '../db/repos/conversations.js'
import { insertMessage } from '../db/repos/messages.js'
import { normalizeCompanionReminderPrompt } from '../lib/companion-cron-prompt.js'
import {
  isCompanionLocalDeliver,
  readHermesCronJobs,
  type HermesCronJob,
} from '../lib/hermes-cron-jobs.js'
import { patchHermesCronJobPrompt } from '../lib/hermes-cron-jobs-patch.js'
import {
  emitAccountConversationUpsert,
  emitConversationMessageUpsert,
} from './chat-sync-emitter.js'

export interface AutoLinkCompanionCronJobsInput {
  db: Database.Database
  userId: string
  username: string
  sourceConversationId: string
  cronJobsPath: string
  knownJobIdsBefore: ReadonlySet<string>
  sawCronjobTool: boolean
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export interface AutoLinkedCompanionCronJob {
  hermesJobId: string
  conversationId: string
}

export async function autoLinkNewCompanionCronJobs(
  input: AutoLinkCompanionCronJobsInput,
): Promise<AutoLinkedCompanionCronJob[]> {
  if (!input.sawCronjobTool) {
    return []
  }

  const sourceConversation = getConversationForUser(
    input.db,
    input.userId,
    input.sourceConversationId,
  )
  if (!sourceConversation || sourceConversation.kind !== 'regular') {
    return []
  }

  const jobs = await readHermesCronJobs(input.cronJobsPath)
  const newLocalJobs = jobs.filter(
    (job) =>
      !input.knownJobIdsBefore.has(job.id) &&
      isCompanionLocalDeliver(job.deliver) &&
      !findConversationByHermesJobId(input.db, job.id),
  )

  const linked: AutoLinkedCompanionCronJob[] = []
  for (const job of newLocalJobs) {
    await normalizeReminderJobPrompt(input, job)
    const conversationId = linkCompanionCronJob(input, job)
    if (!conversationId) {
      continue
    }

    linked.push({ hermesJobId: job.id, conversationId })
    input.log?.('auto-linked companion cron job', {
      hermesJobId: job.id,
      conversationId,
      sourceConversationId: input.sourceConversationId,
    })
  }

  return linked
}

function linkCompanionCronJob(
  input: AutoLinkCompanionCronJobsInput,
  job: HermesCronJob,
): string | null {
  try {
    return input.db.transaction(() => {
      const conversationId = createJobConversation(input.db, input.userId, input.username, {
        name: job.name,
        scheduleDisplay: job.schedule_display,
      })

      linkJobConversation(input.db, input.userId, {
        conversationId,
        hermesJobId: job.id,
        scheduleDisplay: job.schedule_display,
        jobEnabled: job.enabled !== false,
      })

      const seedContent = buildJobSeedMessage(job)
      const messageId = insertMessage(input.db, {
        conversationId,
        role: 'assistant',
        content: seedContent,
      })

      const message = input.db
        .prepare(`
          SELECT id, conversation_id, role, content, created_at
          FROM messages
          WHERE id = ?
        `)
        .get(messageId) as {
        id: string
        conversation_id: string
        role: 'user' | 'assistant'
        content: string
        created_at: string
      }

      emitAccountConversationUpsert(input.db, input.userId, conversationId)
      emitConversationMessageUpsert(input.db, input.userId, conversationId, message)

      return conversationId
    })()
  } catch (error) {
    input.log?.('companion cron auto-link failed', {
      hermesJobId: job.id,
      err: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

async function normalizeReminderJobPrompt(
  input: AutoLinkCompanionCronJobsInput,
  job: HermesCronJob,
): Promise<void> {
  const normalized = normalizeCompanionReminderPrompt({
    name: job.name,
    prompt: job.prompt,
  })
  if (!normalized) {
    return
  }

  const patched = await patchHermesCronJobPrompt(input.cronJobsPath, job.id, normalized)
  if (patched) {
    job.prompt = normalized
    input.log?.('normalized companion reminder cron prompt', {
      hermesJobId: job.id,
    })
  }
}

function buildJobSeedMessage(job: HermesCronJob): string {
  const schedule = job.schedule_display?.trim() || 'scheduled'
  return `Scheduled: ${schedule}\n\n${job.name.trim()}`
}