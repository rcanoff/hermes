export const OBSIDIAN_VAULTS_ROOT = '/opt/data/vaults'
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/

export function companionObsidianVaultPath(username: string): string {
  const cleaned = username.trim()
  if (!USERNAME_RE.test(cleaned)) {
    throw new Error(`invalid companion username for vault path: ${username}`)
  }
  return `${OBSIDIAN_VAULTS_ROOT}/${cleaned.toLowerCase()}`
}

export function companionVaultConstraint(username: string): string {
  const vault = companionObsidianVaultPath(username)
  return `Obsidian vault (only): ${vault}. Do not read or write other directories under ${OBSIDIAN_VAULTS_ROOT}.`
}
