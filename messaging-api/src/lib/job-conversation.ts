export const JOB_CONVERSATION_BOOTSTRAP = `You are in a Companion App **job conversation** (scheduled Hermes cron job).
Before composing your reply, you MUST call skill_view(name='companion-cron') and follow it.
This thread holds job configuration, edits, and scheduled run outputs.`

export function buildJobConversationBootstrap(username: string): string {
  return `${JOB_CONVERSATION_BOOTSTRAP}
The authenticated companion user for this conversation is "${username}".`
}

export function isCronSilentContent(content: string): boolean {
  return content.trim().toUpperCase() === '[SILENT]'
}