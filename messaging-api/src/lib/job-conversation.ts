export const JOB_CONVERSATION_BOOTSTRAP = `You are in a Companion App **job conversation** (scheduled Hermes cron job).
Before composing your reply, you MUST call skill_view(name='companion-cron') and follow it.
This thread holds job configuration, edits, and scheduled run outputs.
When creating or updating reminder prompts, make them useful and self-contained — include links, prices, map blocks, and context from the source conversation so the fired message is actionable without re-research.`

export interface JobConversationLink {
  hermesJobId: string
  name?: string | null
  scheduleDisplay?: string | null
}

export function buildJobConversationBootstrap(
  username: string,
  link?: JobConversationLink | null,
): string {
  const parts = [JOB_CONVERSATION_BOOTSTRAP]

  const jobId = link?.hermesJobId?.trim()
  if (jobId) {
    const name = link?.name?.trim()
    if (name) {
      parts.push(`Linked Hermes cron job: **${name}** (job_id: \`${jobId}\`).`)
    } else {
      parts.push(`Linked Hermes cron job id: \`${jobId}\`.`)
    }

    const schedule = link?.scheduleDisplay?.trim()
    if (schedule) {
      parts.push(`Schedule: \`${schedule}\`.`)
    }

    parts.push(
      `This thread is bound to that job. For run-once / trigger-now requests use cronjob action='run' with that job_id. For pause, resume, update, or remove use the same job_id. Do not call cronjob list to pick a job unless the user asks about other jobs.`,
    )
  }

  parts.push(`The authenticated companion user for this conversation is "${username}".`)

  return parts.join('\n')
}

export function resolveJobConversationBootstrap(
  conversation: {
    kind: 'regular' | 'job'
    bootstrap_prompt: string | null
    hermes_job_id: string | null
    title: string | null
    schedule_display: string | null
  },
  username: string,
): string | null {
  if (conversation.kind !== 'job') {
    return conversation.bootstrap_prompt
  }

  const jobId = conversation.hermes_job_id?.trim()
  if (!jobId) {
    return conversation.bootstrap_prompt
  }

  const existing = conversation.bootstrap_prompt?.trim() ?? ''
  if (existing.includes(jobId)) {
    return existing || null
  }

  return buildJobConversationBootstrap(username, {
    hermesJobId: jobId,
    name: conversation.title,
    scheduleDisplay: conversation.schedule_display,
  })
}

export function isCronSilentContent(content: string): boolean {
  return content.trim().toUpperCase() === '[SILENT]'
}