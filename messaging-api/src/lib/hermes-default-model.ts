import fs from 'node:fs'
import path from 'node:path'

export interface HermesDefaultModel {
  model: string
  provider: string
}

export function hermesConfigPath(hermesHome: string): string {
  return path.join(hermesHome, 'config.yaml')
}

export function readHermesDefaultModel(hermesHome: string): HermesDefaultModel | null {
  let text: string
  try {
    text = fs.readFileSync(hermesConfigPath(hermesHome), 'utf8')
  } catch (error) {
    if (isEnoent(error)) {
      return null
    }
    throw error
  }

  const parsed = parseModelDefaultProvider(text)
  if (!parsed.model || !parsed.provider) {
    return null
  }
  return { model: parsed.model, provider: parsed.provider }
}

export function writeHermesDefaultModel(
  hermesHome: string,
  model: string,
  provider: string,
): void {
  const configPath = hermesConfigPath(hermesHome)
  let text: string | null = null
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch (error) {
    if (!isEnoent(error)) {
      throw error
    }
  }

  const next =
    text === null
      ? `model:\n  default: ${yamlPlainScalar(model)}\n  provider: ${yamlPlainScalar(provider)}\n`
      : replaceModelDefaultProvider(text, model, provider)

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, next)
}

function parseModelDefaultProvider(text: string): { model?: string; provider?: string } {
  const block = modelMappingLines(text.split(/\r?\n/))
  if (!block) {
    return {}
  }

  let model: string | undefined
  let provider: string | undefined
  for (const line of block.childLines) {
    const key = childKeyName(line, block.childIndent)
    if (key === 'default') {
      model = mappingValue(line)
    } else if (key === 'provider') {
      provider = mappingValue(line)
    }
  }
  return { model, provider }
}

function replaceModelDefaultProvider(text: string, model: string, provider: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const endsWithNewline = text.endsWith('\n')
  const lines = text.split(/\r?\n/)
  const block = modelMappingLines(lines)

  if (!block) {
    const prefix = [
      'model:',
      `  default: ${yamlPlainScalar(model)}`,
      `  provider: ${yamlPlainScalar(provider)}`,
      '',
    ]
    return joinLines([...prefix, ...lines], newline, endsWithNewline || text.length === 0)
  }

  const { modelIndex, blockEnd, childIndent } = block
  let defaultIndex = -1
  let providerIndex = -1
  for (let index = modelIndex + 1; index < blockEnd; index += 1) {
    const key = childKeyName(lines[index]!, childIndent)
    if (key === 'default' && defaultIndex < 0) {
      defaultIndex = index
    } else if (key === 'provider' && providerIndex < 0) {
      providerIndex = index
    }
  }

  if (defaultIndex >= 0) {
    lines[defaultIndex] = replaceMappingValue(lines[defaultIndex]!, yamlPlainScalar(model))
  }
  if (providerIndex >= 0) {
    lines[providerIndex] = replaceMappingValue(lines[providerIndex]!, yamlPlainScalar(provider))
  }

  const missing: string[] = []
  if (defaultIndex < 0) {
    missing.push(`${childIndent}default: ${yamlPlainScalar(model)}`)
  }
  if (providerIndex < 0) {
    missing.push(`${childIndent}provider: ${yamlPlainScalar(provider)}`)
  }
  if (missing.length > 0) {
    lines.splice(modelIndex + 1, 0, ...missing)
  }

  return joinLines(lines, newline, endsWithNewline)
}

function modelMappingLines(lines: string[]): {
  modelIndex: number
  blockEnd: number
  childIndent: string
  childLines: string[]
} | null {
  let modelIndex = -1
  let blockEnd = lines.length

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (isBlankOrComment(line)) {
      continue
    }
    const topKey = topLevelKey(line)
    if (!topKey) {
      continue
    }
    if (modelIndex >= 0) {
      blockEnd = index
      break
    }
    if (topKey === 'model') {
      modelIndex = index
    }
  }

  if (modelIndex < 0) {
    return null
  }

  const childLines = lines.slice(modelIndex + 1, blockEnd)
  const childIndent = detectChildIndent(childLines)
  return { modelIndex, blockEnd, childIndent, childLines }
}

function detectChildIndent(childLines: string[]): string {
  for (const line of childLines) {
    if (isBlankOrComment(line)) {
      continue
    }
    const match = line.match(/^(\s+)[A-Za-z0-9_]+\s*:/)
    if (match) {
      return match[1]!
    }
  }
  return '  '
}

function childKeyName(line: string, childIndent: string): string | null {
  if (!line.startsWith(childIndent)) {
    return null
  }
  const rest = line.slice(childIndent.length)
  if (rest.startsWith(' ') || rest.startsWith('\t')) {
    return null
  }
  const match = rest.match(/^([A-Za-z0-9_]+)\s*:/)
  return match ? match[1]! : null
}

function mappingValue(line: string): string | undefined {
  const match = line.match(/^[ \t]*[A-Za-z0-9_]+\s*:\s*(.*)$/)
  if (!match) {
    return undefined
  }
  const raw = stripInlineComment(match[1]!).trim()
  if (!raw) {
    return undefined
  }
  return unquoteYamlScalar(raw)
}

function replaceMappingValue(line: string, nextValue: string): string {
  const match = line.match(/^([ \t]*[A-Za-z0-9_]+)\s*:/)
  if (!match) {
    return line
  }
  return `${match[1]}: ${nextValue}`
}

function topLevelKey(line: string): string | null {
  const match = line.match(/^([A-Za-z0-9_]+)\s*:/)
  return match ? match[1]! : null
}

function isBlankOrComment(line: string): boolean {
  return /^\s*(#|$)/.test(line)
}

function stripInlineComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) {
    return value
  }
  const hash = value.indexOf(' #')
  if (hash >= 0) {
    return value.slice(0, hash)
  }
  return value
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1)
  }
  return value
}

function yamlPlainScalar(value: string): string {
  if (/^[A-Za-z0-9._:+/-]+$/.test(value)) {
    return value
  }
  return JSON.stringify(value)
}

function joinLines(lines: string[], newline: string, endsWithNewline: boolean): string {
  const body = lines.join(newline)
  if (endsWithNewline) {
    return body.endsWith(newline) ? body : `${body}${newline}`
  }
  return body.endsWith(newline) ? body.slice(0, -newline.length) : body
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  )
}
