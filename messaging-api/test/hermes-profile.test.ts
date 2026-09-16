import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBotProfile,
  ensureSkillsOverlay,
  profileDir,
  profileRelativeKey,
  profileSkillsDir,
  profileYamlPath,
  shareDefaultSkills,
  sharedSkillsExternalDir,
  writeProfileYaml,
  type BotProfileOwner,
} from '../src/lib/hermes-profile.js'

const operator: BotProfileOwner = { userId: 'user-rcanoff', username: 'rcanoff' }
const aline: BotProfileOwner = { userId: 'user-aline', username: 'AlineTusi' }

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

  it('no-ops for the operator default home', () => {
    seedCompanionAppSkill()
    shareDefaultSkills(hermesHome, operator, 'default')
    expect(fs.lstatSync(path.join(hermesHome, 'skills')).isSymbolicLink()).toBe(false)
  })

  it('symlinks profile skills so companion-app is visible', () => {
    seedCompanionAppSkill()
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'patrik'), { recursive: true })
    shareDefaultSkills(hermesHome, operator, 'patrik')

    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(path.join(hermesHome, 'skills'))
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(true)
  })

  it('symlinks namespaced default profiles to $HERMES_HOME/skills', () => {
    seedCompanionAppSkill()
    shareDefaultSkills(hermesHome, aline, 'default')

    const dest = path.join(hermesHome, 'profiles', aline.userId, 'default', 'skills')
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

    shareDefaultSkills(hermesHome, operator, 'patrik')
    expect(fs.readlinkSync(dest)).toBe(other)
  })

  it('replaces an empty skills directory with the share', () => {
    seedCompanionAppSkill()
    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    fs.mkdirSync(dest, { recursive: true })

    shareDefaultSkills(hermesHome, operator, 'patrik')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(true)
  })

  it('leaves a non-empty skills directory in place', () => {
    seedCompanionAppSkill()
    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    fs.mkdirSync(path.join(dest, 'local-skill'), { recursive: true })
    fs.writeFileSync(path.join(dest, 'local-skill', 'SKILL.md'), '# local\n')

    shareDefaultSkills(hermesHome, operator, 'patrik')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(dest, 'local-skill', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(false)
  })

  it('creates a dangling symlink when default skills do not exist yet', () => {
    const dest = path.join(hermesHome, 'profiles', 'patrik', 'skills')
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    shareDefaultSkills(hermesHome, operator, 'patrik')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(path.join(hermesHome, 'skills'))
  })
})

describe('profile paths', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-paths-'))
  })

  afterEach(() => {
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  it('keeps rcanoff default at $HERMES_HOME', () => {
    expect(profileRelativeKey(operator, 'default', hermesHome)).toBeNull()
    expect(profileDir(hermesHome, operator, 'default')).toBe(hermesHome)
  })

  it('keeps existing rcanoff extras at profiles/<slug>', () => {
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'patrik'), { recursive: true })
    expect(profileRelativeKey(operator, 'patrik', hermesHome)).toBe('patrik')
    expect(profileDir(hermesHome, operator, 'patrik')).toBe(
      path.join(hermesHome, 'profiles', 'patrik'),
    )
  })

  it('namespaces new rcanoff extras and all non-operator bots', () => {
    expect(profileRelativeKey(operator, 'travel', hermesHome)).toBe(`${operator.userId}/travel`)
    expect(profileRelativeKey(aline, 'default', hermesHome)).toBe(`${aline.userId}/default`)
    expect(profileRelativeKey(aline, 'patrik', hermesHome)).toBe(`${aline.userId}/patrik`)
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

  it('uses a real skills dir and wires shared catalog via external_dirs', () => {
    createBotProfile({
      hermesHome,
      owner: aline,
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'You book trips.',
    })

    const dir = path.join(hermesHome, 'profiles', aline.userId, 'travel')
    const skills = path.join(dir, 'skills')
    expect(fs.lstatSync(skills).isSymbolicLink()).toBe(false)
    expect(fs.statSync(skills).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(hermesHome, 'skills', 'companion-app', 'SKILL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toContain(
      sharedSkillsExternalDir(hermesHome),
    )
    expect(fs.readFileSync(path.join(dir, 'profile.yaml'), 'utf8')).toContain(
      'companion_username: "AlineTusi"',
    )
  })
})

describe('skills overlay', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-overlay-'))
    fs.mkdirSync(path.join(hermesHome, 'skills', 'companion-app'), { recursive: true })
    fs.writeFileSync(path.join(hermesHome, 'skills', 'companion-app', 'SKILL.md'), '# companion-app\n')
  })

  afterEach(() => {
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  it('profileSkillsDir is profileDir/skills for aline/travel', () => {
    expect(profileSkillsDir(hermesHome, aline, 'travel')).toBe(
      path.join(profileDir(hermesHome, aline, 'travel'), 'skills'),
    )
  })

  it('sharedSkillsExternalDir is $HERMES_HOME/skills', () => {
    expect(sharedSkillsExternalDir(hermesHome)).toBe(path.join(hermesHome, 'skills'))
  })

  it('ensureSkillsOverlay converts symlink skills to a real dir and sets external_dirs', () => {
    const dir = profileDir(hermesHome, aline, 'travel')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(path.join(hermesHome, 'skills'), path.join(dir, 'skills'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'skills:\n  external_dirs: []\n')

    ensureSkillsOverlay(hermesHome, aline, 'travel')

    const skills = path.join(dir, 'skills')
    expect(fs.lstatSync(skills).isSymbolicLink()).toBe(false)
    expect(fs.statSync(skills).isDirectory()).toBe(true)
    const config = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
    expect(config).toContain(`- ${sharedSkillsExternalDir(hermesHome)}`)
    expect(config).not.toMatch(/external_dirs:\s*\[\]/)
  })

  it('ensureSkillsOverlay is idempotent and preserves local skill files', () => {
    const dir = profileDir(hermesHome, aline, 'travel')
    const playbook = path.join(dir, 'skills', 'my-playbook')
    fs.mkdirSync(playbook, { recursive: true })
    fs.writeFileSync(path.join(playbook, 'SKILL.md'), '# my-playbook\n')
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `skills:\n  external_dirs:\n    - ${sharedSkillsExternalDir(hermesHome)}\n`,
    )

    ensureSkillsOverlay(hermesHome, aline, 'travel')
    ensureSkillsOverlay(hermesHome, aline, 'travel')

    expect(fs.readFileSync(path.join(playbook, 'SKILL.md'), 'utf8')).toBe('# my-playbook\n')
    const config = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
    expect(config.match(new RegExp(sharedSkillsExternalDir(hermesHome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1)
  })

  it('ensureSkillsOverlay on operator default does not replace $HERMES_HOME/skills', () => {
    const shared = path.join(hermesHome, 'skills')
    expect(fs.existsSync(path.join(shared, 'companion-app', 'SKILL.md'))).toBe(true)

    ensureSkillsOverlay(hermesHome, operator, 'default')

    expect(fs.lstatSync(shared).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(shared, 'companion-app', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(hermesHome, 'skills-local'))).toBe(false)
  })
})

describe('writeProfileYaml', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-yaml-'))
  })

  afterEach(() => {
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  it('records the owner companion username with original casing', () => {
    writeProfileYaml(hermesHome, aline, 'travel', { name: 'Travis', role: 'Travel agent' })

    expect(fs.readFileSync(profileYamlPath(hermesHome, aline, 'travel'), 'utf8')).toBe(
      'display_name: "Travis"\ndescription: "Travel agent"\ncompanion_username: "AlineTusi"\n',
    )
  })
})
