import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { BrowserDaemonConfig } from './config.js'

export interface BraveStatus {
  running: boolean
  profileDir: string
  profileName: string
  cdpUrl: string
  browser?: string
  webSocketDebuggerUrl?: string
}

export class BraveLauncher {
  private launching: Promise<void> | null = null

  constructor(private readonly config: BrowserDaemonConfig) {}

  cdpBaseUrl(): string {
    return `http://127.0.0.1:${this.config.braveCdpPort}`
  }

  async isCdpReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.cdpBaseUrl()}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async fetchCdpVersion(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.cdpBaseUrl()}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) {
      throw new Error(`Brave CDP /json/version returned ${response.status}`)
    }
    return (await response.json()) as Record<string, unknown>
  }

  rewriteWebSocketUrl(webSocketDebuggerUrl: string): string {
    const url = new URL(webSocketDebuggerUrl)
    url.hostname = this.config.cdpPublicHost
    url.port = String(this.config.cdpPublicPort)
    return url.toString()
  }

  async status(): Promise<BraveStatus> {
    const base: BraveStatus = {
      running: false,
      profileDir: this.config.profileDir,
      profileName: this.config.profileName,
      cdpUrl: this.cdpBaseUrl(),
    }

    if (!(await this.isCdpReady())) {
      return base
    }

    const version = await this.fetchCdpVersion()
    const ws = String(version.webSocketDebuggerUrl ?? '')
    return {
      ...base,
      running: true,
      browser: String(version.Browser ?? ''),
      webSocketDebuggerUrl: ws ? this.rewriteWebSocketUrl(ws) : undefined,
    }
  }

  async ensureRunning(): Promise<BraveStatus> {
    if (await this.isCdpReady()) {
      return this.status()
    }

    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = null
      })
    }

    await this.launching
    return this.status()
  }

  private async launch(): Promise<void> {
    await mkdir(this.config.profileDir, { recursive: true })

    if (process.platform === 'darwin') {
      spawn(
        'open',
        [
          '-na',
          'Brave Browser',
          '--args',
          `--remote-debugging-port=${this.config.braveCdpPort}`,
          `--user-data-dir=${this.config.profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          'about:blank',
        ],
        { detached: true, stdio: 'ignore' },
      ).unref()
    } else {
      spawn(
        this.config.braveApp,
        [
          `--remote-debugging-port=${this.config.braveCdpPort}`,
          `--user-data-dir=${this.config.profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          'about:blank',
        ],
        { detached: true, stdio: 'ignore' },
      ).unref()
    }

    const deadline = Date.now() + this.config.launchTimeoutMs
    while (Date.now() < deadline) {
      if (await this.isCdpReady()) {
        return
      }
      await sleep(this.config.pollIntervalMs)
    }

    throw new Error(
      `Brave did not start CDP on port ${this.config.braveCdpPort} within ${this.config.launchTimeoutMs}ms`,
    )
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}