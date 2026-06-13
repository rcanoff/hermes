function humanizeToolName(name: string): string {
  return name.replace(/_/g, ' ').trim()
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function synthesizeArgsFromLabel(name: string, label: string): string | undefined {
  if (name === 'skill_view') {
    return JSON.stringify({ name: label })
  }

  if (name === 'skills_list') {
    return JSON.stringify({ category: label })
  }

  if (name === 'tool_search' || name === 'web_search') {
    return JSON.stringify({ query: label })
  }

  if (name === 'read_file') {
    return JSON.stringify({ path: label })
  }

  return undefined
}

export function formatToolProcessLine(name: string, argumentsJson?: string, label?: string): string {
  if (label?.trim()) {
    const syntheticArgs = synthesizeArgsFromLabel(name, label.trim())
    if (syntheticArgs) {
      return formatToolProcessLine(name, syntheticArgs)
    }
  }

  const args = parseArgs(argumentsJson)

  if (name === 'skills_list') {
    const category = stringArg(args, 'category')
    return category ? `Listing skills: ${category}` : 'Listing skills'
  }

  if (name === 'skill_view') {
    const skill = stringArg(args, 'name')
    return skill ? `Loading skill: ${skill}` : 'Loading skill'
  }

  if (name === 'tool_search') {
    const query = stringArg(args, 'query')
    return query ? `Searching tools: ${query}` : 'Searching tools'
  }

  if (name === 'mcp_ha_ha_get_state' || name === 'ha_get_state') {
    const entity = stringArg(args, 'entity_id')
    return entity ? `Getting Home Assistant state: ${entity}` : 'Getting Home Assistant state'
  }

  if (name === 'mcp_ha_ha_search_entities') {
    const query = stringArg(args, 'query')
    return query ? `Searching Home Assistant: ${query}` : 'Searching Home Assistant'
  }

  if (name === 'read_file') {
    const path = stringArg(args, 'path')
    return path ? `Reading file: ${path}` : 'Reading file'
  }

  if (name === 'web_search') {
    const query = stringArg(args, 'query')
    return query ? `Searching the web: ${query}` : 'Searching the web'
  }

  if (name === 'terminal' || name === 'execute_code') {
    return 'Running command'
  }

  if (name === 'delegate_task') {
    return 'Delegating task'
  }

  return `Running ${humanizeToolName(name)}`
}