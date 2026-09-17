import fs from 'node:fs'
import path from 'node:path'
import {
  HermesDashboardError,
  type HermesCreateProfileInput,
  type HermesCreateProfileResult,
  type HermesDashboard,
  type HermesDeleteProfileResult,
  type HermesProfileRecord,
} from '../../src/lib/hermes-dashboard.js'

const FALLBACK_CONFIG = 'platforms:\n  api_server:\n    extra:\n      port: 8642\n'

export function createFakeHermesDashboard(hermesHome: string): HermesDashboard {
  function profileDir(name: string): string {
    return path.join(hermesHome, 'profiles', name)
  }

  function profileExists(name: string): boolean {
    try {
      return fs.statSync(profileDir(name)).isDirectory()
    } catch {
      return false
    }
  }

  return {
    async getProfile(name: string): Promise<HermesProfileRecord | null> {
      return profileExists(name) ? { name } : null
    },

    async createProfile(input: HermesCreateProfileInput): Promise<HermesCreateProfileResult> {
      if (profileExists(input.name)) {
        throw new HermesDashboardError('hermes_profile_taken', 409, 'hermes_profile_taken')
      }

      const dir = profileDir(input.name)
      fs.mkdirSync(dir, { recursive: true })

      const sourceConfig = path.join(hermesHome, 'config.yaml')
      const destConfig = path.join(dir, 'config.yaml')
      if (fs.existsSync(sourceConfig)) {
        fs.copyFileSync(sourceConfig, destConfig)
      } else {
        fs.writeFileSync(destConfig, FALLBACK_CONFIG)
      }

      return { ok: true, name: input.name, path: dir }
    },

    async deleteProfile(name: string): Promise<HermesDeleteProfileResult> {
      if (!profileExists(name)) {
        return { ok: true, missing: true }
      }
      fs.rmSync(profileDir(name), { recursive: true, force: true })
      return { ok: true }
    },
  }
}
