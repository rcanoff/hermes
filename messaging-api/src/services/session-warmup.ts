import type { ConversationRow } from '../db/repos/conversations.js'
import { resolveJobConversationBootstrap } from '../lib/job-conversation.js'
import type { HermesClient } from './hermes-client.js'
import { buildHermesSystemPrompt } from './prompt-builder.js'

export function scheduleConversationSessionWarmup(input: {
  hermesClient: HermesClient
  conversation: Pick<
    ConversationRow,
    | 'hermes_session_id'
    | 'bootstrap_prompt'
    | 'kind'
    | 'hermes_job_id'
    | 'title'
    | 'schedule_display'
  >
  companionUsername?: string
  log?: (message: string, meta?: Record<string, unknown>) => void
}): void {
  const bootstrapPrompt = input.companionUsername
    ? resolveJobConversationBootstrap(input.conversation, input.companionUsername)
    : input.conversation.bootstrap_prompt

  const systemPrompt = buildHermesSystemPrompt({
    bootstrapPrompt,
    companionUsername: input.companionUsername,
  })

  void input.hermesClient
    .ensureSession({
      hermesSessionId: input.conversation.hermes_session_id,
      systemPrompt: systemPrompt || null,
    })
    .catch((error) => {
      input.log?.('conversation session warmup failed', {
        hermesSessionId: input.conversation.hermes_session_id,
        err: error instanceof Error ? error.message : String(error),
      })
    })
}