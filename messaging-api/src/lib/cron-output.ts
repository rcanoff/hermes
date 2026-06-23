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
  const markerIndex = findLastResponseHeadingIndex(content)
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

/** Parse `2026-06-21_15-25-49` from a cron output filename (UTC, Hermes convention). */
export function parseCronOutputFilenameTimestamp(filename: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/i.exec(filename)
  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return null
  }

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second))
}

/** Parse `2026-06-21 15:25:49` from cron output markdown (UTC, Hermes convention). */
export function parseCronRunTimeString(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return null
  }

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second))
}

export function parseCronOutputPath(
  outputDir: string,
  absolutePath: string,
): { hermesJobId: string; relativePath: string; filename: string } | null {
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
    filename: segments[1]!,
  }
}

/** Match only markdown headings, not inline mentions inside loaded skill bodies. */
function findLastResponseHeadingIndex(content: string): number {
  const pattern = /(?:^|\n)## Response(?=\r?\n|$)/g
  let last = -1
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    last = match.index + (match[0].startsWith('\n') ? 1 : 0)
  }

  return last
}