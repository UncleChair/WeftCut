import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installSkills } from './skillsInstall.js'

const tmps: string[] = []
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-skills-install-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/// Stand-in for out/skills: one skill folder with the doc build-skills.mjs
/// stages beside it.
function stageSkills(root: string, body: string): string {
  fs.mkdirSync(path.join(root, 'weftcut'), { recursive: true })
  fs.writeFileSync(path.join(root, 'weftcut', 'SKILL.md'), body)
  fs.writeFileSync(path.join(root, 'weftcut', 'motif-authoring.md'), `doc for ${body}`)
  return root
}

describe('installSkills', () => {
  it('copies the packaged tree into <userData>/skills and returns the folder', () => {
    const userData = tmpDir()
    const source = stageSkills(tmpDir(), 'skill v1')
    const dest = installSkills({ resourcesSkills: source, devSkills: 'X:\\nope', isPackaged: true, userDataDir: userData })
    expect(dest).toBe(path.join(userData, 'skills'))
    expect(fs.readFileSync(path.join(dest!, 'weftcut', 'SKILL.md'), 'utf8')).toBe('skill v1')
    expect(fs.readFileSync(path.join(dest!, 'weftcut', 'motif-authoring.md'), 'utf8')).toBe('doc for skill v1')
  })

  it('refreshes shipped files on every start but keeps what the user added', () => {
    const userData = tmpDir()
    const source = stageSkills(tmpDir(), 'skill v1')
    const opts = { resourcesSkills: source, devSkills: 'X:\\nope', isPackaged: true, userDataDir: userData }
    installSkills(opts)
    const mine = path.join(userData, 'skills', 'mine', 'SKILL.md')
    fs.mkdirSync(path.dirname(mine), { recursive: true })
    fs.writeFileSync(mine, 'my own skill')

    stageSkills(source, 'skill v2')
    installSkills(opts)

    expect(fs.readFileSync(path.join(userData, 'skills', 'weftcut', 'SKILL.md'), 'utf8')).toBe('skill v2')
    expect(fs.readFileSync(mine, 'utf8')).toBe('my own skill')
  })

  it('dev without a staged bundle: keeps a pre-existing copy, else reports none', () => {
    const userData = tmpDir()
    const opts = { resourcesSkills: 'X:\\nope', devSkills: 'X:\\also-nope', isPackaged: false, userDataDir: userData }
    expect(installSkills(opts)).toBeNull()
    const dest = path.join(userData, 'skills')
    fs.mkdirSync(dest, { recursive: true })
    expect(installSkills(opts)).toBe(dest)
  })
})
