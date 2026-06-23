import type Database from 'better-sqlite3'
import {
  createJobConversation,
  findConversationByHermesJobId,
  getConversationForUser,
  linkJobConversation,
} from '../db/repos/conversations.js'
import { insertMessage } from '../db/repos/messages.js'
import { companionCronModelPatch } from '../lib/companion-cron-model.js'
import { companionCronSkillsPatch } from '../lib/companion-cron-skills.js'
import {
  buildHomeAssistantDigestCronPrompt,
  HOME_ASSISTANT_DIGEST_PROMPT_MARKER,
  normalizeHomeAssistantDigestPrompt,
} from '../lib/companion-cron-prompt.js'

import {
  isCompanionLocalDeliver,
  readHermesCronJobs,
  type HermesCronJob,
} from '../lib/hermes-cron-jobs.js'
import {
  patchHermesCronJobModel,
  patchHermesCronJobPrompt,
  patchHermesCronJobSkills,
} from '../lib/hermes-cron-jobs-patch.js'
import {
  emitAccountConversationUpsert,
  emitConversationMessageUpsert,
} from './chat-sync-emitter.js'
import type { AuxiliaryLlmConfig } from './auxiliary-llm-client.js'
import { classifyAndSynthesizeCompanionCronPromptFromConversation } from './cron-prompt-synthesizer.js'
import type { HermesClient } from './hermes-client.js'

export interface AutoLinkCompanionCronJobsInput {
  db: Database.Database
  userId: string
  username: string
  sourceConversationId: string
  cronJobsPath: string
  knownJobIdsBefore: ReadonlySet<string>
  sawCronjobTool: boolean
  hermesClient?: HermesClient
  cronPromptSynthesisLlm?: AuxiliaryLlmConfig | null
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
    await normalizeCompanionJobRecord(input, job)
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
        username: input.username,
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

async function normalizeCompanionJobRecord(
  input: AutoLinkCompanionCronJobsInput,
  job: HermesCronJob,
): Promise<void> {
  const existingPrompt = job.prompt?.trim() ?? ''
  if (existingPrompt.includes(HOME_ASSISTANT_DIGEST_PROMPT_MARKER)) {
    await patchCompanionJobMetadata(input, job)
    return
  }

  const canonicalDigestPrompt = normalizeHomeAssistantDigestPrompt({
    name: job.name,
    prompt: job.prompt,
    schedule_display: job.schedule_display,
  })

  if (input.hermesClient) {
    const classified = await classifyAndSynthesizeCompanionCronPromptFromConversation({
      db: input.db,
      hermesClient: input.hermesClient,
      synthesisLlm: input.cronPromptSynthesisLlm,
      sourceConversationId: input.sourceConversationId,
      job,
    })

    if (classified) {
      const nextPrompt = resolvePromptForClassifiedJob(classified, canonicalDigestPrompt)
      if (nextPrompt && nextPrompt !== existingPrompt) {
        const patched = await patchHermesCronJobPrompt(input.cronJobsPath, job.id, nextPrompt)
        if (patched) {
          job.prompt = nextPrompt
          input.log?.('classified and patched companion cron prompt', {
            hermesJobId: job.id,
            kind: classified.kind,
            sourceConversationId: input.sourceConversationId,
          })
        }
      } else if (classified.kind !== 'ha_digest' && !nextPrompt) {
        input.log?.('companion cron prompt classification produced no prompt', {
          hermesJobId: job.id,
          kind: classified.kind,
          sourceConversationId: input.sourceConversationId,
        })
      }

      await patchCompanionJobMetadata(input, job)
      return
    }

    input.log?.('companion cron prompt classification skipped or failed', {
      hermesJobId: job.id,
      sourceConversationId: input.sourceConversationId,
    })
  }

  if (canonicalDigestPrompt && canonicalDigestPrompt !== existingPrompt) {
    const patched = await patchHermesCronJobPrompt(input.cronJobsPath, job.id, canonicalDigestPrompt)
    if (patched) {
      job.prompt = canonicalDigestPrompt
      input.log?.('normalized companion HA digest cron prompt', {
        hermesJobId: job.id,
      })
    }
  }

  await patchCompanionJobMetadata(input, job)
}

function resolvePromptForClassifiedJob(
  classified: { kind: string; prompt: string | null },
  canonicalDigestPrompt: string | null,
): string | null {
  if (classified.kind === 'ha_digest') {
    return canonicalDigestPrompt ?? buildHomeAssistantDigestCronPrompt()
  }

  return classified.prompt
}

async function patchCompanionJobMetadata(
  input: AutoLinkCompanionCronJobsInput,
  job: HermesCronJob,
): Promise<void> {
  const skillsPatch = companionCronSkillsPatch(job.skills, {
    name: job.name,
    prompt: job.prompt,
  })
  if (skillsPatch) {
    const patched = await patchHermesCronJobSkills(input.cronJobsPath, job.id, skillsPatch)
    if (patched) {
      job.skills = skillsPatch
      input.log?.('patched companion cron job skills', {
        hermesJobId: job.id,
        skills: skillsPatch,
      })
    }
  }

  const modelPatch = companionCronModelPatch({
    model: job.model,
    provider: job.provider,
  })
  if (!modelPatch) {
    return
  }

  const patchedModel = await patchHermesCronJobModel(
    input.cronJobsPath,
    job.id,
    modelPatch.model,
    modelPatch.provider,
  )
  if (patchedModel) {
    job.model = modelPatch.model
    job.provider = modelPatch.provider
    input.log?.('patched companion cron job model', {
      hermesJobId: job.id,
      model: modelPatch.model,
      provider: modelPatch.provider,
    })
  }
}

function buildJobSeedMessage(job: HermesCronJob): string {
  const schedule = job.schedule_display?.trim() || 'scheduled'
  return `Scheduled: ${schedule}\n\n${job.name.trim()}`
}