import path from 'node:path'

export interface BrowserDaemonConfig {
  port: number
  braveCdpPort: number
  profileName: string
  profileDir: string
  cdpPublicHost: string
  cdpPublicPort: number
  braveApp: string
  launchTimeoutMs: number
  pollIntervalMs: number
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveHermesDataDir(env: NodeJS.ProcessEnv, cwd: string): string {
  const configured = env.HERMES_DATA_DIR?.trim()
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured)
  }
  return path.resolve(cwd, '../data')
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): BrowserDaemonConfig {
  const profileName = env.BRAVE_PROFILE_NAME?.trim() || 'hermes'
  const dataDir = resolveHermesDataDir(env, cwd)

  return {
    port: readPositiveInt(env.PORT, 9221),
    braveCdpPort: readPositiveInt(env.BRAVE_CDP_PORT, 9222),
    profileName,
    profileDir: path.join(dataDir, 'browser-profiles', profileName),
    cdpPublicHost: env.CDP_PUBLIC_HOST?.trim() || 'host.docker.internal',
    cdpPublicPort: readPositiveInt(env.CDP_PUBLIC_PORT, readPositiveInt(env.PORT, 9221)),
    braveApp:
      env.BRAVE_APP?.trim() ||
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    launchTimeoutMs: readPositiveInt(env.BRAVE_LAUNCH_TIMEOUT_MS, 20_000),
    pollIntervalMs: readPositiveInt(env.BRAVE_POLL_INTERVAL_MS, 250),
  }
}