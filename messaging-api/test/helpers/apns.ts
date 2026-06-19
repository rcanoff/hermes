import type { ApnsClient, ApnsSendInput, ApnsSendResult } from '../../src/services/apns-client.js'
import type { ApnsConfig } from '../../src/config.js'

export function createRecordingApnsClient(sends: ApnsSendInput[]): ApnsClient {
  return {
    async send(input: ApnsSendInput): Promise<ApnsSendResult> {
      sends.push(input)
      return { ok: true }
    },
  }
}

export function disabledApnsConfig(): ApnsConfig {
  return {
    enabled: false,
    teamId: '',
    keyId: '',
    bundleId: '',
    keyPath: '',
    environment: 'development',
    previewMaxChars: 120,
  }
}

export function enabledApnsConfig(overrides: Partial<ApnsConfig> = {}): ApnsConfig {
  return {
    enabled: true,
    teamId: 'TEAM',
    keyId: 'KEY',
    bundleId: 'com.example.app',
    keyPath: '/tmp/apns.p8',
    environment: 'development',
    previewMaxChars: 120,
    ...overrides,
  }
}