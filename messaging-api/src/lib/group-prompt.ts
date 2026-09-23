export const GROUP_PROMPT_CHAR_BUDGET = 24_000

// ponytail: character ceiling, replace when a tokenizer exists.
export const GROUP_SYSTEM_PROMPT =
  'Answer only the primary request. You have no tools and cannot impersonate members.'

export interface GroupPromptLine {
  author: string
  text: string
}

export function buildGroupPrompt(input: {
  botName: string
  context: GroupPromptLine[]
  primary: { username: string; text: string }
}): { text: string; fits: boolean } {
  const fits = input.primary.text.length + GROUP_SYSTEM_PROMPT.length <= GROUP_PROMPT_CHAR_BUDGET
  const lines = fits ? [...input.context] : []
  while (lines.length > 0 && renderGroupPrompt(input, lines).length > GROUP_PROMPT_CHAR_BUDGET) {
    lines.shift()
  }
  return { text: renderGroupPrompt(input, lines), fits }
}

function renderGroupPrompt(
  input: { botName: string; primary: { username: string; text: string } },
  lines: GroupPromptLine[],
): string {
  const context = lines.map((line) => `${line.author}: ${line.text}`).join('\n')
  return [
    GROUP_SYSTEM_PROMPT,
    context,
    `Primary request from ${input.primary.username}:\n${input.primary.text}`,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
}
