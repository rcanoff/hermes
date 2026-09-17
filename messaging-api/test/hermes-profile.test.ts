import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addHonchoHost,
  createBotProfile,
  ensureSkillsOverlay,
  profileDir,
  profileSkillsDir,
  profileYamlPath,
  removeHonchoHost,
  shareDefaultSkills,
  sharedSkillsExternalDir,
  stripClonedApiServer,
  writeProfileYaml,
  type BotProfileOwner,
} from '../src/lib/hermes-profile.js'

const aline: BotProfileOwner = { userId: 'user-aline', username: 'AlineTusi' }
const aliceTravel = 'alice-travel'

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
    shareDefaultSkills(hermesHome, null)
    expect(fs.lstatSync(path.join(hermesHome, 'skills')).isSymbolicLink()).toBe(false)
  })

  it('symlinks profile skills so companion-app is visible', () => {
    seedCompanionAppSkill()
    fs.mkdirSync(path.join(hermesHome, 'profiles', aliceTravel), { recursive: true })
    shareDefaultSkills(hermesHome, aliceTravel)

    const dest = path.join(hermesHome, 'profiles', aliceTravel, 'skills')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(dest)).toBe(path.join(hermesHome, 'skills'))
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(true)
  })

  it('returns if dest is already a symlink', () => {
    const dest = path.join(hermesHome, 'profiles', aliceTravel, 'skills')
    const other = path.join(hermesHome, 'other-skills')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.mkdirSync(other)
    fs.symlinkSync(other, dest)

    shareDefaultSkills(hermesHome, aliceTravel)
    expect(fs.readlinkSync(dest)).toBe(other)
  })

  it('replaces an empty skills directory with the share', () => {
    seedCompanionAppSkill()
    const dest = path.join(hermesHome, 'profiles', aliceTravel, 'skills')
    fs.mkdirSync(dest, { recursive: true })

    shareDefaultSkills(hermesHome, aliceTravel)
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(true)
  })

  it('leaves a non-empty skills directory in place', () => {
    seedCompanionAppSkill()
    const dest = path.join(hermesHome, 'profiles', aliceTravel, 'skills')
    fs.mkdirSync(path.join(dest, 'local-skill'), { recursive: true })
    fs.writeFileSync(path.join(dest, 'local-skill', 'SKILL.md'), '# local\n')

    shareDefaultSkills(hermesHome, aliceTravel)
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(dest, 'local-skill', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'companion-app', 'SKILL.md'))).toBe(false)
  })

  it('creates a dangling symlink when default skills do not exist yet', () => {
    const dest = path.join(hermesHome, 'profiles', aliceTravel, 'skills')
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    shareDefaultSkills(hermesHome, aliceTravel)
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

  it('keeps operator default at $HERMES_HOME', () => {
    expect(profileDir(hermesHome, null)).toBe(hermesHome)
  })

  it('uses the hermes name string for named profiles', () => {
    expect(profileDir(hermesHome, aliceTravel)).toBe(
      path.join(hermesHome, 'profiles', aliceTravel),
    )
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

    const dir = path.join(hermesHome, 'profiles', 'alinetusi-travel')
    const skills = path.join(dir, 'skills')
    expect(fs.existsSync(path.join(hermesHome, 'profiles', aline.userId, 'travel'))).toBe(false)
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

  it('profileSkillsDir is profileDir/skills for alice-travel', () => {
    expect(profileSkillsDir(hermesHome, aliceTravel)).toBe(
      path.join(profileDir(hermesHome, aliceTravel), 'skills'),
    )
  })

  it('sharedSkillsExternalDir is $HERMES_HOME/skills', () => {
    expect(sharedSkillsExternalDir(hermesHome)).toBe(path.join(hermesHome, 'skills'))
  })

  it('ensureSkillsOverlay converts symlink skills to a real dir and sets external_dirs', () => {
    const dir = profileDir(hermesHome, aliceTravel)
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(path.join(hermesHome, 'skills'), path.join(dir, 'skills'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'skills:\n  external_dirs: []\n')

    ensureSkillsOverlay(hermesHome, aliceTravel)

    const skills = path.join(dir, 'skills')
    expect(fs.lstatSync(skills).isSymbolicLink()).toBe(false)
    expect(fs.statSync(skills).isDirectory()).toBe(true)
    const config = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
    expect(config).toContain(`- ${sharedSkillsExternalDir(hermesHome)}`)
    expect(config).not.toMatch(/external_dirs:\s*\[\]/)
  })

  it('ensureSkillsOverlay is idempotent and preserves local skill files', () => {
    const dir = profileDir(hermesHome, aliceTravel)
    const playbook = path.join(dir, 'skills', 'my-playbook')
    fs.mkdirSync(playbook, { recursive: true })
    fs.writeFileSync(path.join(playbook, 'SKILL.md'), '# my-playbook\n')
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `skills:\n  external_dirs:\n    - ${sharedSkillsExternalDir(hermesHome)}\n`,
    )

    ensureSkillsOverlay(hermesHome, aliceTravel)
    ensureSkillsOverlay(hermesHome, aliceTravel)

    expect(fs.readFileSync(path.join(playbook, 'SKILL.md'), 'utf8')).toBe('# my-playbook\n')
    const config = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
    expect(config.match(new RegExp(sharedSkillsExternalDir(hermesHome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1)
  })

  it('ensureSkillsOverlay on operator default does not replace $HERMES_HOME/skills', () => {
    const shared = path.join(hermesHome, 'skills')
    expect(fs.existsSync(path.join(shared, 'companion-app', 'SKILL.md'))).toBe(true)

    ensureSkillsOverlay(hermesHome, null)

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
    writeProfileYaml(hermesHome, 'alinetusi-travel', {
      name: 'Travis',
      role: 'Travel agent',
      companionUsername: aline.username,
    })

    expect(fs.readFileSync(profileYamlPath(hermesHome, 'alinetusi-travel'), 'utf8')).toBe(
      'display_name: "Travis"\ndescription: "Travel agent"\ncompanion_username: "AlineTusi"\n',
    )
  })
})

describe('stripClonedApiServer', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-strip-'))
  })

  afterEach(() => {
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  function profileDirWithConfig(yaml: string): string {
    const dir = path.join(hermesHome, 'profiles', aliceTravel)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), yaml)
    return dir
  }

  it('strips platforms.api_server from cloned config', () => {
    const dir = profileDirWithConfig(
      'platforms:\n  api_server:\n    extra:\n      port: 8642\n  telegram:\n    enabled: true\n',
    )
    stripClonedApiServer(dir)
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
    expect(text).not.toMatch(/api_server/)
    expect(text).toContain('telegram:\n    enabled: true')
  })

  it('preserves telegram and other sibling platform keys', () => {
    const dir = profileDirWithConfig(
      'platforms:\n  api_server:\n    extra:\n      port: 8642\n  telegram:\n    enabled: true\n  discord:\n    enabled: false\n',
    )
    stripClonedApiServer(dir)
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
    expect(text).not.toMatch(/api_server/)
    expect(text).toContain('telegram:')
    expect(text).toContain('discord:')
  })

  it('does not throw when config.yaml is missing', () => {
    const dir = path.join(hermesHome, 'profiles', aliceTravel)
    fs.mkdirSync(dir, { recursive: true })
    expect(() => stripClonedApiServer(dir)).not.toThrow()
    expect(fs.existsSync(path.join(dir, 'config.yaml'))).toBe(false)
  })

  it('leaves an already stripped config unchanged', () => {
    const yaml = 'model:\n  default: test-model\nplatforms:\n  telegram:\n    enabled: true\n'
    const dir = profileDirWithConfig(yaml)
    stripClonedApiServer(dir)
    stripClonedApiServer(dir)
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe(yaml)
  })

  it('does not strip nested display.platforms.api_server', () => {
    const yaml =
      'display:\n  platforms:\n    api_server:\n      extra: true\nplatforms:\n  api_server:\n    extra:\n      port: 8642\n  telegram:\n    enabled: true\n'
    const dir = profileDirWithConfig(yaml)
    stripClonedApiServer(dir)
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
    expect(text).toContain('display:\n  platforms:\n    api_server:\n      extra: true')
    expect(text).toContain('telegram:')
    expect(text).not.toMatch(/^platforms:\n  api_server:/m)
    expect(text.match(/api_server:/g)).toEqual(['api_server:'])
  })
})

describe('honcho hosts', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-honcho-'))
  })

  afterEach(() => {
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  it('addHonchoHost keys hermes.{profileName}', () => {
    fs.writeFileSync(path.join(hermesHome, 'honcho.json'), JSON.stringify({ hosts: { hermes: {} } }))
    addHonchoHost(hermesHome, aliceTravel)
    const hosts = JSON.parse(fs.readFileSync(path.join(hermesHome, 'honcho.json'), 'utf8')).hosts
    expect(hosts['hermes.alice-travel']).toEqual({ aiPeer: 'alice-travel' })
  })

  it('removeHonchoHost deletes both dotted and underscored keys', () => {
    fs.writeFileSync(
      path.join(hermesHome, 'honcho.json'),
      JSON.stringify({ hosts: { 'hermes.alice-travel': { aiPeer: 'x' }, hermes_alice_travel: { aiPeer: 'x' } } }),
    )
    removeHonchoHost(hermesHome, aliceTravel)
    const hosts = JSON.parse(fs.readFileSync(path.join(hermesHome, 'honcho.json'), 'utf8')).hosts
    expect(hosts['hermes.alice-travel']).toBeUndefined()
    expect(hosts.hermes_alice_travel).toBeUndefined()
  })
})
