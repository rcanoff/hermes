import type { ConversationRow } from '../db/repos/conversations.js'
import { modelDisplayName, type CuratedModelEntry } from './companion-models.js'

export function toConversationResponse(
  conversation: ConversationRow,
  catalog: CuratedModelEntry[],
) {
  const { bootstrap_prompt: _bootstrapPrompt, job_enabled, ...rest } = conversation
  const response: Record<string, unknown> = {
    ...rest,
    kind: conversation.kind,
    model: conversation.model,
    provider: conversation.provider,
    model_display: modelDisplayName(catalog, conversation.model, conversation.provider),
  }

  if (conversation.kind === 'job') {
    response.job_enabled = job_enabled === 1
    response.hermes_job_id = conversation.hermes_job_id
    response.schedule_display = conversation.schedule_display
    response.job_last_run_at = conversation.job_last_run_at
    response.job_last_status = conversation.job_last_status
  }

  return response
}