import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotProfile, shareDefaultSkills } from '../src/lib/hermes-profile.js'

describe('shareDefaultSkills', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-skills-'))
  })

  afterEach(() => {
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  function seedCompanionAppSkill() {
    const skillDir = path.join(hermesHome, 'skills', 'companion-app')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# companion-app\n')
  }

  it('no-ops for the default slug', () => {
    seedCompanionAppSkill()
    shareDefaultSkills(hermesHome, 'default')
    expect(fs.lstatSync(path.join(hermesHome, 'skills')).isSymbolicLink()).toBe(false)
  })

  it('symlinks profile skills so companion-app is visible', () => {
    seedCompanionAppSkill()
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'patrik'), { recursive: true })
    shareDefaultSkills(hermesHome, 'patrik')

    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(path.join(hermesHome, 'skills'))
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(true)
  })

  it('returns if dest is already a symlink', () => {
    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    const other = path.join(hermesHome, 'other-skills')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.mkdirSync(other)
    fs.symlinkSync(other, dest)

    shareDefaultSkills(hermesHome, 'patrik')
    expect(fs.readlinkSync(dest)).toBe(other)
  })

  it('replaces an empty skills directory with the share', () => {
    seedCompanionAppSkill()
    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    fs.mkdirSync(dest, { recursive: true })

    shareDefaultSkills(hermesHome, 'patrik')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(true)
  })

  it('leaves a non-empty skills directory in place', () => {
    seedCompanionAppSkill()
    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    fs.mkdirSync(path.join(dest, 'local-skill'), { recursive: true })
    fs.writeFileSync(path.join(dest, 'local-skill', 'SKILL.md'), '# local\n')

    shareDefaultSkills(hermesHome, 'patrik')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(dest, 'local-skill', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(false)
  })

  it('creates a dangling symlink when default skills do not exist yet', () => {
    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    shareDefaultSkills(hermesHome, 'patrik')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(path.join(hermesHome, 'skills'))
  })
})

describe('createBotProfile', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-profile-'))
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: test-model\n')
    const skillDir = path.join(hermesHome, 'skills', 'companion-app')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# companion-app\n')
  })

  afterEach(() => {
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  it('shares default skills so companion-app is visible on the new profile', () => {
    createBotProfile({
      hermesHome,
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'You book trips.',
    })

    const profileDir = path.join(hermesHome, 'profiles', 'travel')
    expect(fs.existsSync(path.join(profileDir, 'skills', 'companion-app', 'SKILL.md'))).toBe(true)
    expect(fs.lstatSync(path.join(profileDir, 'skills')).isSymbolicLink()).toBe(true)
  })
})
