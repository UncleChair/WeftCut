// apps/desktop/src/main/state/migrate.completeness.test.ts
//
// The gate that makes "a schema bump ships its migration step" a red test rather
// than a review comment. It is the whole reason issue #14 was a v1 blocker: the
// first bump AFTER release is the one that cannot be fixed later, so the rule has
// to be mechanical before that bump, not after.
//
// Three claims, and every one of them holds vacuously at v1 — that is expected.
// They grow teeth the moment a second generation exists.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { MIN_SCHEMA_VERSION, STEPS, upgradeWire } from './migrate'
import { SCHEMA_VERSION } from './model'
import { parseProject } from './serialize'
import { validate } from './validate'

const DIR = 'fixtures/projects'
const fixturePath = (v: number) => `${DIR}/v${v}.json`

describe('the migration chain covers every shipped generation', () => {
  it('has exactly one step per generation between the floor and the build', () => {
    // A bump without a step fails HERE, before anything reaches a user.
    expect(MIN_SCHEMA_VERSION + STEPS.length).toBe(SCHEMA_VERSION)
  })

  it('registers those steps at the exact versions in between', () => {
    const expected = Array.from({ length: SCHEMA_VERSION - MIN_SCHEMA_VERSION }, (_, i) => MIN_SCHEMA_VERSION + i)
    expect(STEPS.map((s) => s.from)).toEqual(expected)
  })
})

describe('every shipped generation has a frozen fixture', () => {
  // Inclusive of the CURRENT version: the shape being shipped right now is the
  // next step's input, so it goes on record while it is still the truth. Waiting
  // until the bump means reconstructing it from git.
  const versions = Array.from({ length: SCHEMA_VERSION - MIN_SCHEMA_VERSION + 1 }, (_, i) => MIN_SCHEMA_VERSION + i)

  it.each(versions)('v%i has a committed fixture', (v) => {
    expect(existsSync(fixturePath(v)), `missing ${fixturePath(v)} — see ${DIR}/README.md`).toBe(true)
  })

  it.each(versions)('v%i upgrades to the current schema and validates', (v) => {
    const wire = JSON.parse(readFileSync(fixturePath(v), 'utf8')) as Record<string, unknown>
    // The declared version must match the filename, or the fixture is testing a
    // different generation than it claims and the coverage above is a lie.
    expect(wire.schema_version).toBe(v)

    const { wire: upgraded } = upgradeWire(wire, v, SCHEMA_VERSION)
    expect(upgraded.schema_version).toBe(SCHEMA_VERSION)
    // parseProject + validate are the real load path's two judges: the structural
    // cast plus the same invariant check `replaceState` runs. A step that produces
    // a shape the app would refuse to open fails right here.
    const project = parseProject(upgraded, { onGridRepair: () => {} })
    expect(() => validate(project)).not.toThrow()
  })

  it('holds no fixture for a version the chain cannot place', () => {
    const stray = readdirSync(DIR)
      .filter((n) => /^v\d+\.json$/.test(n))
      .map((n) => Number(/^v(\d+)\.json$/.exec(n)![1]))
      .filter((v) => !versions.includes(v))
    expect(stray, 'a fixture whose version is outside [MIN_SCHEMA_VERSION, SCHEMA_VERSION]').toEqual([])
  })
})
