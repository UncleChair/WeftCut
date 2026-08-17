// apps/desktop/src/main/state/migrate.contract.test.ts
//
// The one mechanical guard on migrate.ts's authoring contract. This repo has no
// linter, so a source-level rule has nowhere else to live: reading the file is
// the enforcement.
//
// WHY IT MATTERS: a migration step is a frozen statement about a shape that has
// already passed into history. The moment a step can reach the live model, its
// meaning starts tracking today's code instead of the file it was written for —
// and that failure is invisible here and only surfaces on a real user's old
// project. So steps get no imports: wire objects in, local types for the fields
// they touch, frozen literals for anything they write.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync('src/main/state/migrate.ts', 'utf8')
/** Comments talk ABOUT the model on purpose; only code is under the ban. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('migrate.ts authoring contract', () => {
  it('never imports the live model', () => {
    expect(CODE).not.toMatch(/from\s+['"]\.\/model['"]/)
  })

  it('imports nothing at all', () => {
    // Stricter than the rule above, and deliberately so: `./model` is merely the
    // most tempting door. Anything imported here can be edited later by someone
    // who has no idea a five-year-old migration reads it. If a step genuinely
    // needs a helper, inline it — and if that becomes untenable, loosening this
    // is a decision to make on purpose, in the ADR, not by deleting a test.
    const imports = CODE.split('\n').filter((l) => /^\s*import[\s{*]/.test(l))
    expect(imports).toEqual([])
  })

  it('does not reference the current SCHEMA_VERSION in code', () => {
    // The target version is a PARAMETER (`upgradeWire(wire, from, to)`). A step
    // that read the constant would silently re-target itself on the next bump.
    expect(CODE).not.toMatch(/\bSCHEMA_VERSION\b/)
  })
})
