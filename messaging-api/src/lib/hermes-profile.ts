import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_BOT_SLUG = 'default'
export const OPERATOR_USERNAME = 'rcanoff'
export const BOT_SLUG_PATTERN = /^[a-z0-9-]{1,32}$/
export const HERMES_PROFILE_NAME_MAX = 64
export const HERMES_RESERVED_PROFILE_NAMES = new Set([
  'default',
  'hermes',
  'test',
  'tmp',
  'root',
  'sudo',
])
/** Shared platform catalog under `$HERMES_HOME/skills` (wired via `skills.external_dirs`). */
export const SHARED_SKILLS_EXTERNAL = 'skills'

export type HermesProfileNameResult =
  | { ok: true; name: string | null }
  | { ok: false; error: 'invalid_request' | 'reserved' }

export function hermesProfileName(username: string, slug: string): HermesProfileNameResult {
  const user = username.trim().toLowerCase()
  const s = slug.trim().toLowerCase()
  if (user === OPERATOR_USERNAME && s === DEFAULT_BOT_SLUG) {
    return { ok: true, name: null }
  }
  const name = `${user}-${s}`
  if (name.length > HERMES_PROFILE_NAME_MAX || name.length < 1) {
    return { ok: false, error: 'invalid_request' }
  }
  if (HERMES_RESERVED_PROFILE_NAMES.has(name)) {
    return { ok: false, error: 'reserved' }
  }
  return { ok: true, name }
}

const HONCHO_CONFIG_NAME = 'honcho.json'

export interface BotProfileOwner {
  userId: string
  username: string
}

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

export function isOperatorOwner(owner: BotProfileOwner): boolean {
  return owner.username === OPERATOR_USERNAME
}

/**
 * Relative path under `$HERMES_HOME/profiles`, or `null` for the operator
 * default home (`$HERMES_HOME` itself).
 *
 * rcanoff default → home. Existing rcanoff extras at `profiles/<slug>/` stay.
 * New bots and every non-rcanoff bot → `profiles/<userId>/<slug>/`.
 */
export function profileRelativeKey(
  owner: BotProfileOwner,
  slug: string,
  hermesHome?: string,
): string | null {
  if (slug === DEFAULT_BOT_SLUG && isOperatorOwner(owner)) {
    return null
  }

  const namespaced = `${owner.userId}/${slug}`
  if (hermesHome && isOperatorOwner(owner)) {
    const legacyDir = path.join(hermesHome, 'profiles', slug)
    const namespacedDir = path.join(hermesHome, 'profiles', owner.userId, slug)
    if (fs.existsSync(legacyDir) && !fs.existsSync(namespacedDir)) {
      return slug
    }
  }

  return namespaced
}

export function profileDir(hermesHome: string, owner: BotProfileOwner, slug: string): string {
  const key = profileRelativeKey(owner, slug, hermesHome)
  if (key === null) {
    return hermesHome
  }
  return path.join(hermesHome, 'profiles', ...key.split('/'))
}

export function soulFilePath(hermesHome: string, owner: BotProfileOwner, slug: string): string {
  return path.join(profileDir(hermesHome, owner, slug), 'SOUL.md')
}

export function profileYamlPath(hermesHome: string, owner: BotProfileOwner, slug: string): string {
  return path.join(profileDir(hermesHome, owner, slug), 'profile.yaml')
}

export function readSoulFile(
  hermesHome: string,
  owner: BotProfileOwner,
  slug: string,
): string | null {
  try {
    return fs.readFileSync(soulFilePath(hermesHome, owner, slug), 'utf8')
  } catch {
    return null
  }
}

/** Writes the bot's `SOUL.md`. Callers must skip `runtime=grok`. */
export function writeSoulFile(
  hermesHome: string,
  owner: BotProfileOwner,
  slug: string,
  soul: string,
): void {
  const dir = profileDir(hermesHome, owner, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(soulFilePath(hermesHome, owner, slug), soul)
}

export function defaultSoulFromRole(name: string, role: string): string {
  return `You are the ${name} assistant. ${role}`.trim()
}

function isOperatorHome(hermesHome: string, owner: BotProfileOwner, slug: string): boolean {
  return profileDir(hermesHome, owner, slug) === hermesHome
}

/** Writes `profile.yaml` for Hermes multiplex profiles. Callers must skip `runtime=grok`. */
export function writeProfileYaml(
  hermesHome: string,
  owner: BotProfileOwner,
  slug: string,
  input: { name: string; role: string },
): void {
  if (isOperatorHome(hermesHome, owner, slug)) {
    return
  }

  const dir = profileDir(hermesHome, owner, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    profileYamlPath(hermesHome, owner, slug),
    `display_name: ${yamlScalar(input.name)}\ndescription: ${yamlScalar(input.role)}\ncompanion_username: ${yamlScalar(owner.username)}\n`,
  )
}

/** Absolute path to the shared skills catalog (`$HERMES_HOME/skills`). */
export function sharedSkillsExternalDir(hermesHome: string): string {
  return path.join(hermesHome, SHARED_SKILLS_EXTERNAL)
}

/** Bot-writable skills directory under the profile (or `$HERMES_HOME/skills` for operator default). */
export function profileSkillsDir(hermesHome: string, owner: BotProfileOwner, slug: string): string {
  return path.join(profileDir(hermesHome, owner, slug), SHARED_SKILLS_EXTERNAL)
}

/**
 * Legacy helper: symlink profile `skills` → `$HERMES_HOME/skills`.
 * Prefer `ensureSkillsOverlay` (real dir + `skills.external_dirs`) for new profiles.
 */
export function shareDefaultSkills(
  hermesHome: string,
  owner: BotProfileOwner,
  slug: string,
): void {
  if (isOperatorHome(hermesHome, owner, slug)) {
    return
  }

  const dest = path.join(profileDir(hermesHome, owner, slug), 'skills')
  const source = sharedSkillsExternalDir(hermesHome)

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

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.symlinkSync(source, dest)
}

/**
 * Multiplex profiles: real writable `skills/` + `config.yaml` `skills.external_dirs`
 * including the shared catalog. Operator home is the shared tree — no-op there.
 */
export function ensureSkillsOverlay(
  hermesHome: string,
  owner: BotProfileOwner,
  slug: string,
): void {
  if (isOperatorHome(hermesHome, owner, slug)) {
    return
  }

  const dir = profileDir(hermesHome, owner, slug)
  fs.mkdirSync(dir, { recursive: true })
  ensureRealProfileSkillsDir(dir)
  ensureSharedExternalDirs(path.join(dir, 'config.yaml'), sharedSkillsExternalDir(hermesHome))
}

/** Convert symlink/`missing` → real `skills/`; leave an existing real directory alone. */
function ensureRealProfileSkillsDir(profilePath: string): void {
  const dest = path.join(profilePath, 'skills')
  try {
    const stat = fs.lstatSync(dest)
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(dest)
      fs.mkdirSync(dest, { recursive: true })
      return
    }
    if (stat.isDirectory()) {
      return
    }
    return
  } catch (error) {
    if (!isEnoent(error)) {
      throw error
    }
  }
  fs.mkdirSync(dest, { recursive: true })
}

/** Idempotently add `shared` to `skills.external_dirs` in profile `config.yaml`. */
function ensureSharedExternalDirs(configPath: string, shared: string): void {
  let text: string
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch (error) {
    if (!isEnoent(error)) {
      throw error
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, `skills:\n  external_dirs:\n    - ${shared}\n`)
    return
  }

  if (externalDirsIncludes(text, shared)) {
    return
  }

  const emptyMatch = text.match(/(^|\n)([ \t]*)external_dirs:[ \t]*\[[ \t]*\][ \t]*(?=\r?\n|$)/)
  if (emptyMatch && emptyMatch.index !== undefined) {
    const indent = emptyMatch[2] ?? ''
    const start = emptyMatch.index + emptyMatch[1].length
    const end = emptyMatch.index + emptyMatch[0].length
    const replacement = `${indent}external_dirs:\n${indent}  - ${shared}`
    fs.writeFileSync(configPath, `${text.slice(0, start)}${replacement}${text.slice(end)}`)
    return
  }

  const listHeader = text.match(/(^|\n)([ \t]*)external_dirs:[ \t]*(?=\r?\n|$)/)
  if (listHeader && listHeader.index !== undefined) {
    const indent = listHeader[2] ?? ''
    const afterHeader = listHeader.index + listHeader[0].length
    const insertion = `\n${indent}  - ${shared}`
    fs.writeFileSync(configPath, `${text.slice(0, afterHeader)}${insertion}${text.slice(afterHeader)}`)
    return
  }

  const skillsHeader = text.match(/(^|\n)skills:[ \t]*(?=\r?\n|$)/)
  if (skillsHeader && skillsHeader.index !== undefined) {
    const afterSkills = skillsHeader.index + skillsHeader[0].length
    const insertion = `\n  external_dirs:\n    - ${shared}`
    fs.writeFileSync(configPath, `${text.slice(0, afterSkills)}${insertion}${text.slice(afterSkills)}`)
    return
  }

  const suffix = text.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(configPath, `${text}${suffix}skills:\n  external_dirs:\n    - ${shared}\n`)
}

function externalDirsIncludes(text: string, shared: string): boolean {
  const escaped = shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\n)[ \\t]*-[ \\t]*"?${escaped}"?[ \\t]*(?=\\r?\\n|$)`).test(text)
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  )
}

/** Writes a multiplex Hermes profile. Callers must skip `runtime=grok` and the operator home. */
export function createBotProfile(input: {
  hermesHome: string
  owner: BotProfileOwner
  slug: string
  name: string
  role: string
  soul: string
}): void {
  if (isOperatorHome(input.hermesHome, input.owner, input.slug)) {
    throw new Error('cannot_create_default_profile')
  }

  const dir = profileDir(input.hermesHome, input.owner, input.slug)
  fs.mkdirSync(dir, { recursive: true })

  const sourceConfig = path.join(input.hermesHome, 'config.yaml')
  if (fs.existsSync(sourceConfig)) {
    fs.copyFileSync(sourceConfig, path.join(dir, 'config.yaml'))
  }

  syncProfileApiServerKey(input.hermesHome, input.owner, input.slug)
  ensureSkillsOverlay(input.hermesHome, input.owner, input.slug)
  fs.writeFileSync(soulFilePath(input.hermesHome, input.owner, input.slug), input.soul)
  writeProfileYaml(input.hermesHome, input.owner, input.slug, {
    name: input.name,
    role: input.role,
  })
}

/** Multiplex `/p/<key>` auth requires a profile-scoped API_SERVER_KEY; it does not inherit default. */
export function syncProfileApiServerKey(
  hermesHome: string,
  owner: BotProfileOwner,
  slug: string,
): void {
  if (isOperatorHome(hermesHome, owner, slug)) {
    return
  }

  const key = readDotEnvValue(path.join(hermesHome, '.env'), 'API_SERVER_KEY')
  if (!key) {
    return
  }

  upsertDotEnvValue(path.join(profileDir(hermesHome, owner, slug), '.env'), 'API_SERVER_KEY', key)
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

/** Removes a multiplex profile dir. No-op for the operator home. Callers must skip `runtime=grok`. */
export function deleteBotProfile(
  hermesHome: string,
  owner: BotProfileOwner,
  slug: string,
): void {
  if (isOperatorHome(hermesHome, owner, slug)) {
    return
  }
  fs.rmSync(profileDir(hermesHome, owner, slug), { recursive: true, force: true })
}

/** Adds a honcho peer for a Hermes profile. Callers must skip `runtime=grok`. */
export function addHonchoHost(hermesHome: string, owner: BotProfileOwner, slug: string): void {
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
    const relative = profileRelativeKey(owner, slug, hermesHome)
    const key = relative === null ? `hermes.${slug}` : `hermes.${relative.replaceAll('/', '.')}`
    if (hosts[key]) {
      return
    }

    const aiPeer = relative === null || !relative.includes('/') ? slug : relative.replaceAll('/', '.')
    hosts[key] = { aiPeer }
    root.hosts = hosts
    fs.writeFileSync(honchoPath, `${JSON.stringify(root, null, 2)}\n`)
  } catch {
    // Best-effort: missing or malformed honcho.json must not fail bot create.
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
}
