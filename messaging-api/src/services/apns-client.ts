import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http2 from 'node:http2'
import type { ApnsConfig } from '../config.js'

export interface ApnsSendInput {
  deviceToken: string
  environment: 'development' | 'production'
  payload: Record<string, unknown>
}

export type ApnsSendResult =
  | { ok: true }
  | { ok: false; status: number; reason?: string; unregistered?: boolean }

export interface ApnsClient {
  send(input: ApnsSendInput): Promise<ApnsSendResult>
}

export function apnsHost(environment: 'development' | 'production'): string {
  return environment === 'production'
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com'
}

function base64Url(value: Buffer | string): string {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value
  return buffer.toString('base64url')
}

export function buildApnsJwt(input: {
  teamId: string
  keyId: string
  privateKeyPem: string
  issuedAt?: number
}): string {
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: input.keyId }))
  const iat = input.issuedAt ?? Math.floor(Date.now() / 1000)
  const payload = base64Url(JSON.stringify({ iss: input.teamId, iat }))
  const signingInput = `${header}.${payload}`
  const key = createPrivateKey({ key: input.privateKeyPem, format: 'pem' })
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${base64Url(signature)}`
}

export function createTestApnsPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
}

export function createApnsClient(config: ApnsConfig): ApnsClient {
  if (!config.enabled) {
    return {
      async send() {
        return { ok: true }
      },
    }
  }

  const privateKeyPem = readFileSync(config.keyPath, 'utf8')
  let cachedJwt = ''
  let cachedJwtIssuedAt = 0

  function authorizationHeader(): string {
    const now = Math.floor(Date.now() / 1000)
    if (!cachedJwt || now - cachedJwtIssuedAt >= 3000) {
      cachedJwt = buildApnsJwt({
        teamId: config.teamId,
        keyId: config.keyId,
        privateKeyPem,
        issuedAt: now,
      })
      cachedJwtIssuedAt = now
    }
    return `bearer ${cachedJwt}`
  }

  return {
    async send(input: ApnsSendInput): Promise<ApnsSendResult> {
      const host = apnsHost(input.environment)
      const body = JSON.stringify(input.payload)

      return new Promise((resolve) => {
        const client = http2.connect(`https://${host}`)

        const fail = (status: number, reason?: string, unregistered = false) => {
          client.close()
          resolve({ ok: false, status, reason, unregistered })
        }

        client.on('error', () => {
          fail(0, 'connection_error')
        })

        const request = client.request({
          ':method': 'POST',
          ':path': `/3/device/${input.deviceToken}`,
          authorization: authorizationHeader(),
          'apns-topic': config.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        })

        request.setEncoding('utf8')
        let responseBody = ''

        request.on('response', (headers) => {
          const status = Number(headers[':status'] ?? 0)
          if (status === 200) {
            client.close()
            resolve({ ok: true })
            return
          }

          request.on('data', (chunk: string) => {
            responseBody += chunk
          })

          request.on('end', () => {
            let reason: string | undefined
            try {
              const parsed = JSON.parse(responseBody) as { reason?: string }
              reason = parsed.reason
            } catch {
              reason = undefined
            }
            fail(status, reason, status === 410 || reason === 'Unregistered')
          })
        })

        request.end(body)
      })
    },
  }
}