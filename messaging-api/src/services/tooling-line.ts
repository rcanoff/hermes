import type { ToolingLine } from '../db/repos/process.js'
import { formatToolProcessLine } from './process-labeler.js'

const MAX_ARG_STRING_LENGTH = 120

const PRESENTATION_KEYS: Record<string, string[]> = {
  memory: ['action', 'target'],
  skill_view: ['name'],
  skills_list: ['category'],
  skill_manage: ['action', 'name'],
  web_search: ['query'],
  tool_search: ['query'],
  read_file: ['path'],
  terminal: ['command'],
  execute_code: ['code'],
  delegate_task: ['goal'],
}

const OMIT_ARG_KEYS = new Set(['content', 'password', 'secret', 'token'])

export function parseToolArgs(argumentsJson?: string): Record<string, unknown> | null {
  if (!argumentsJson?.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(argumentsJson) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function truncateString(value: string): string {
  if (value.length <= MAX_ARG_STRING_LENGTH) {
    return value
  }
  return `${value.slice(0, MAX_ARG_STRING_LENGTH)}…`
}

function truncateArgValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return truncateString(value)
  }
  return value
}

export function pickPresentationArgs(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const keys = PRESENTATION_KEYS[tool]
  if (keys) {
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (!(key in args) || args[key] == null || OMIT_ARG_KEYS.has(key)) {
        continue
      }
      result[key] = truncateArgValue(args[key])
    }
    return Object.keys(result).length > 0 ? result : null
  }

  if (tool.startsWith('mcp_')) {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (OMIT_ARG_KEYS.has(key)) {
        continue
      }
      result[key] = truncateArgValue(value)
    }
    return Object.keys(result).length > 0 ? result : null
  }

  return null
}

export function resolveActivityText(
  tool: string,
  label?: string,
  args?: Record<string, unknown> | null,
): string {
  if (label?.trim()) {
    return label.trim()
  }

  const argsJson = args ? JSON.stringify(args) : undefined
  return formatToolProcessLine(tool, argsJson)
}

export function buildActivityLine(input: {
  tool: string
  label?: string
  argumentsJson?: string
}): ToolingLine {
  const args = parseToolArgs(input.argumentsJson) ?? {}
  const presentationArgs = pickPresentationArgs(input.tool, args)
  const text = resolveActivityText(input.tool, input.label, args)

  return {
    phase: 'activity',
    text,
    tool: input.tool,
    ...(presentationArgs != null ? { args: presentationArgs } : {}),
  }
}

export function buildStatusLine(input: { text: string; tool?: string | null }): ToolingLine {
  return {
    phase: 'status',
    text: input.text,
    tool: input.tool ?? null,
    args: null,
  }
}

export function buildReasoningLine(text: string): ToolingLine {
  return {
    phase: 'reasoning',
    text,
  }
}