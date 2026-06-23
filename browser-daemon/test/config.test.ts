import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'

describe('readConfig', () => {
  it('defaults to the hermes profile under HERMES_DATA_DIR', () => {
    const cwd = '/workspace/hermes/browser-daemon'
    const config = readConfig(
      {
        HERMES_DATA_DIR: '../data',
        PORT: '9221',
      },
      cwd,
    )

    expect(config.profileName).toBe('hermes')
    expect(config.profileDir).toBe(
      path.resolve(cwd, '../data/browser-profiles/hermes'),
    )
    expect(config.port).toBe(9221)
    expect(config.braveCdpPort).toBe(9222)
    expect(config.cdpPublicHost).toBe('host.docker.internal')
  })
})