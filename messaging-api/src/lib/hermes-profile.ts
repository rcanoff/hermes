import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_BOT_SLUG = 'default'
export const BOT_SLUG_PATTERN = /^[a-z0-9-]{1,32}$/

const HONCHO_CONFIG_NAME = 'honcho.json'

export function slugifyBotName(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')

  if (!BOT_SLUG_PATTERN.test(slug)) {
    return null
  }

  return slug
}

export function isValidBotSlug(slug: string): boolean {
  return BOT_SLUG_PATTERN.test(slug)
}

export function profileDir(hermesHome: string, slug: string): string {
  if (slug === DEFAULT_BOT_SLUG) {
    return hermesHome
  }
  return path.join(hermesHome, 'profiles', slug)
}

export function soulFilePath(hermesHome: string, slug: string): string {
  return path.join(profileDir(hermesHome, slug), 'SOUL.md')
}

export function profileYamlPath(hermesHome: string, slug: string): string {
  return path.join(profileDir(hermesHome, slug), 'profile.yaml')
}

export function readSoulFile(hermesHome: string, slug: string): string | null {
  try {
    return fs.readFileSync(soulFilePath(hermesHome, slug), 'utf8')
  } catch {
    return null
  }
}

/** Writes `$HERMES_HOME/profiles/<slug>/SOUL.md`. Callers must skip `runtime=grok`. */
export function writeSoulFile(hermesHome: string, slug: string, soul: string): void {
  const dir = profileDir(hermesHome, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(soulFilePath(hermesHome, slug), soul)
}

export function defaultSoulFromRole(name: string, role: string): string {
  return `You are the ${name} assistant. ${role}`.trim()
}

/** Writes `profile.yaml` for Hermes multiplex profiles. Callers must skip `runtime=grok`. */
export function writeProfileYaml(
  hermesHome: string,
  slug: string,
  input: { name: string; role: string },
): void {
  if (slug === DEFAULT_BOT_SLUG) {
    return
  }

  const dir = profileDir(hermesHome, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    profileYamlPath(hermesHome, slug),
    `display_name: ${yamlScalar(input.name)}\ndescription: ${yamlScalar(input.role)}\n`,
  )
}

/** Point `profiles/<slug>/skills` at `$HERMES_HOME/skills` so multiplex profiles see default skills. */
export function shareDefaultSkills(hermesHome: string, slug: string): void {
  if (slug === DEFAULT_BOT_SLUG) {
    return
  }

  const dest = path.join(profileDir(hermesHome, slug), 'skills')
  const source = path.join(hermesHome, 'skills')

  try {
    const stat = fs.lstatSync(dest)
    if (stat.isSymbolicLink()) {
      return
    }
    if (stat.isDirectory()) {
      if (fs.readdirSync(dest).length > 0) {
        return
      }
      fs.rmdirSync(dest)
    } else {
      return
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error
    }
  }

  fs.symlinkSync(source, dest)
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  )
}

/** Writes `$HERMES_HOME/profiles/<slug>/`. Callers must skip `runtime=grok`. */
export function createBotProfile(input: {
  hermesHome: string
  slug: string
  name: string
  role: string
  soul: string
}): void {
  if (input.slug === DEFAULT_BOT_SLUG) {
    throw new Error('cannot_create_default_profile')
  }

  const dir = profileDir(input.hermesHome, input.slug)
  fs.mkdirSync(dir, { recursive: true })
  shareDefaultSkills(input.hermesHome, input.slug)

  const sourceConfig = path.join(input.hermesHome, 'config.yaml')
  if (fs.existsSync(sourceConfig)) {
    fs.copyFileSync(sourceConfig, path.join(dir, 'config.yaml'))
  }

  syncProfileApiServerKey(input.hermesHome, input.slug)
  fs.writeFileSync(soulFilePath(input.hermesHome, input.slug), input.soul)
  writeProfileYaml(input.hermesHome, input.slug, { name: input.name, role: input.role })
}

/** Multiplex `/p/<slug>` auth requires a profile-scoped API_SERVER_KEY; it does not inherit default. */
export function syncProfileApiServerKey(hermesHome: string, slug: string): void {
  if (slug === DEFAULT_BOT_SLUG) {
    return
  }

  const key = readDotEnvValue(path.join(hermesHome, '.env'), 'API_SERVER_KEY')
  if (!key) {
    return
  }

  upsertDotEnvValue(path.join(profileDir(hermesHome, slug), '.env'), 'API_SERVER_KEY', key)
}

function readDotEnvValue(envPath: string, name: string): string | null {
  let text: string
  try {
    text = fs.readFileSync(envPath, 'utf8')
  } catch {
    return null
  }

  const prefix = `${name}=`
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim()
      return value ? unquoteEnvValue(value) : null
    }
  }
  return null
}

function upsertDotEnvValue(envPath: string, name: string, value: string): void {
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  let text = ''
  try {
    text = fs.readFileSync(envPath, 'utf8')
  } catch {
    fs.writeFileSync(envPath, `${name}=${value}\n`)
    return
  }

  const prefix = `${name}=`
  const lines = text.split(/\n/)
  let replaced = false
  const next = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith(prefix)) {
      return line
    }
    replaced = true
    return `${name}=${value}`
  })
  if (!replaced) {
    if (next.length === 1 && next[0] === '') {
      next[0] = `${name}=${value}`
    } else {
      if (next.length > 0 && next[next.length - 1] === '') {
        next[next.length - 1] = `${name}=${value}`
        next.push('')
      } else {
        next.push(`${name}=${value}`)
      }
    }
  }
  const body = next.join('\n')
  fs.writeFileSync(envPath, body.endsWith('\n') ? body : `${body}\n`)
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/** Removes `$HERMES_HOME/profiles/<slug>/`. Callers must skip `runtime=grok`. */
export function deleteBotProfile(hermesHome: string, slug: string): void {
  if (slug === DEFAULT_BOT_SLUG) {
    return
  }
  fs.rmSync(profileDir(hermesHome, slug), { recursive: true, force: true })
}

/** Adds a honcho peer for a Hermes profile slug. Callers must skip `runtime=grok`. */
export function addHonchoHost(hermesHome: string, slug: string): void {
  const honchoPath = path.join(hermesHome, HONCHO_CONFIG_NAME)
  if (!fs.existsSync(honchoPath)) {
    return
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(honchoPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return
    }

    const root = parsed as { hosts?: unknown }
    const hosts =
      root.hosts && typeof root.hosts === 'object' && !Array.isArray(root.hosts)
        ? { ...(root.hosts as Record<string, unknown>) }
        : {}
    const key = `hermes.${slug}`
    if (hosts[key]) {
      return
    }

    hosts[key] = { aiPeer: slug }
    root.hosts = hosts
    fs.writeFileSync(honchoPath, `${JSON.stringify(root, null, 2)}\n`)
  } catch {
    // Best-effort: missing or malformed honcho.json must not fail bot create.
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
}
