const RESPONSE_HEADER = '## Response'

export interface ParsedCronOutput {
  response: string
  runAt: string | null
}

export function parseCronOutputMarkdown(content: string): ParsedCronOutput | null {
  const response = extractResponseSection(content)
  if (response === null) {
    return null
  }

  return {
    response,
    runAt: extractRunTime(content),
  }
}

export function extractResponseSection(content: string): string | null {
  const markerIndex = content.indexOf(RESPONSE_HEADER)
  if (markerIndex < 0) {
    return null
  }

  let body = content.slice(markerIndex + RESPONSE_HEADER.length)
  body = body.replace(/^\s*\r?\n/, '')

  const nextHeading = body.search(/\r?\n## /)
  if (nextHeading >= 0) {
    body = body.slice(0, nextHeading)
  }

  const trimmed = body.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function extractRunTime(content: string): string | null {
  const match = /\*\*Run Time:\*\*\s*(.+)/.exec(content)
  if (!match?.[1]) {
    return null
  }

  const value = match[1].trim()
  return value.length > 0 ? value : null
}

export function parseCronOutputPath(
  outputDir: string,
  absolutePath: string,
): { hermesJobId: string; relativePath: string } | null {
  const normalizedDir = outputDir.replace(/\/+$/, '')
  const normalizedPath = absolutePath.replace(/\\/g, '/')

  if (!normalizedPath.startsWith(`${normalizedDir}/`)) {
    return null
  }

  const relativePath = normalizedPath.slice(normalizedDir.length + 1)
  const segments = relativePath.split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]?.endsWith('.md')) {
    return null
  }

  return {
    hermesJobId: segments[0]!,
    relativePath,
  }
}