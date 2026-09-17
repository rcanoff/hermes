export const HERMES_DASHBOARD_CREATE_TIMEOUT_MS = 10_000
export const HERMES_DASHBOARD_DELETE_TIMEOUT_MS = 15_000
export const HERMES_DASHBOARD_GET_TIMEOUT_MS = 10_000
export const HERMES_DASHBOARD_LOGIN_TIMEOUT_MS = 10_000

export type HermesDashboardErrorCode =
  | 'hermes_profile_taken'
  | 'invalid_request'
  | 'unavailable'

export class HermesDashboardError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: HermesDashboardErrorCode,
  ) {
    super(message)
    this.name = 'HermesDashboardError'
  }
}

export interface HermesDashboardClientOptions {
  baseUrl: string
  username: string
  password: string
}

export interface HermesCreateProfileInput {
  name: string
  description: string
}

export interface HermesCreateProfileResult {
  ok: true
  name: string
  path?: string
}

export interface HermesDeleteProfileResult {
  ok: true
  missing?: true
  settlementPending?: true
}

export interface HermesProfileRecord {
  name: string
}

export interface HermesDashboard {
  createProfile(input: HermesCreateProfileInput): Promise<HermesCreateProfileResult>
  deleteProfile(name: string): Promise<HermesDeleteProfileResult>
  getProfile(name: string): Promise<HermesProfileRecord | null>
}

export class HermesDashboardClient implements HermesDashboard {
  private readonly baseUrl: string
  private readonly username: string
  private readonly password: string
  private cookie: string | null = null
  private loginPromise: Promise<void> | null = null

  constructor(options: HermesDashboardClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '')
    this.username = options.username
    this.password = options.password
  }

  async createProfile(input: HermesCreateProfileInput): Promise<HermesCreateProfileResult> {
    const response = await this.request(
      '/api/profiles',
      {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          clone_from: 'default',
          clone_from_default: false,
          clone_all: false,
          clone_channels: false,
          no_skills: false,
        }),
      },
      HERMES_DASHBOARD_CREATE_TIMEOUT_MS,
    )

    if (!response.ok) {
      throw await this.errorFrom(response)
    }

    const payload = await readJson(response)
    const name = stringField(payload, 'name') ?? input.name
    const path = stringField(payload, 'path')
    return path ? { ok: true, name, path } : { ok: true, name }
  }

  async deleteProfile(name: string): Promise<HermesDeleteProfileResult> {
    const response = await this.request(
      `/api/profiles/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
      HERMES_DASHBOARD_DELETE_TIMEOUT_MS,
    )

    if (response.status === 404) {
      return { ok: true, missing: true }
    }

    if (response.status === 409) {
      const text = await response.text().catch(() => '')
      if (/settlement_pending/i.test(text)) {
        return { ok: true, settlementPending: true }
      }
      throw this.errorFromBody(response.status, text)
    }

    if (!response.ok) {
      throw await this.errorFrom(response)
    }

    return { ok: true }
  }

  async getProfile(name: string): Promise<HermesProfileRecord | null> {
    const response = await this.request(
      `/api/profiles/${encodeURIComponent(name)}`,
      { method: 'GET' },
      HERMES_DASHBOARD_GET_TIMEOUT_MS,
    )

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw await this.errorFrom(response)
    }

    const payload = await readJson(response)
    return { name: stringField(payload, 'name') ?? name }
  }

  private async ensureSession(): Promise<void> {
    if (this.cookie) {
      return
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().catch((error: unknown) => {
        this.loginPromise = null
        throw error
      })
    }
    await this.loginPromise
  }

  private async login(): Promise<void> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/auth/password-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'basic',
          username: this.username,
          password: this.password,
        }),
        signal: AbortSignal.timeout(HERMES_DASHBOARD_LOGIN_TIMEOUT_MS),
      })
    } catch (error) {
      throw unavailableFrom(error)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new HermesDashboardError(text || 'unavailable', response.status, 'unavailable')
    }

    const cookie = cookieFromResponse(response)
    if (!cookie) {
      throw new HermesDashboardError('missing session cookie', response.status, 'unavailable')
    }
    this.cookie = cookie
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    await this.ensureSession()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    }
    if (this.cookie) {
      headers.cookie = this.cookie
    }

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw unavailableFrom(error)
    }
  }

  private async errorFrom(response: Response): Promise<HermesDashboardError> {
    const text = await response.text().catch(() => '')
    return this.errorFromBody(response.status, text)
  }

  private errorFromBody(status: number, text: string): HermesDashboardError {
    if ((status === 409 || status === 400) && /exists/i.test(text)) {
      return new HermesDashboardError(text || 'hermes_profile_taken', status, 'hermes_profile_taken')
    }
    if (status === 409) {
      return new HermesDashboardError(text || 'hermes_profile_taken', status, 'hermes_profile_taken')
    }
    if (status === 400) {
      return new HermesDashboardError(text || 'invalid_request', status, 'invalid_request')
    }
    return new HermesDashboardError(text || 'unavailable', status, 'unavailable')
  }
}

function cookieFromResponse(response: Response): string | null {
  const headers = response.headers
  const listed = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const raw = listed[0] ?? headers.get('set-cookie')
  if (!raw) {
    return null
  }
  const pair = raw.split(';')[0]?.trim()
  return pair || null
}

function unavailableFrom(error: unknown): HermesDashboardError {
  if (error instanceof HermesDashboardError) {
    return error
  }
  const message = error instanceof Error ? error.message : 'unavailable'
  return new HermesDashboardError(message, 0, 'unavailable')
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null
    }
    return payload as Record<string, unknown>
  } catch {
    return null
  }
}

function stringField(payload: Record<string, unknown> | null, key: string): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' && value ? value : undefined
}
