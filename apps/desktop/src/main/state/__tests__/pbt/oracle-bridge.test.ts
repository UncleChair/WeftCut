// TRANSITIONAL: validates the new invariants against the frozen Rust-generated
// oracle, then is deleted with the corpus (Task 13). Proves the invariants do
// not reject known-good states before we remove the snapshot that proves it.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAllInvariants } from './invariants'
import type { WireProject } from './harness'

const ORACLE = fileURLToPath(new URL('../../../../../fixtures/state-corpus/oracle', import.meta.url))

describe('new invariants accept every frozen oracle state', () => {
  const files = readdirSync(ORACLE).filter((f) => f.endsWith('.json'))
  it('corpus is present', () => expect(files.length).toBeGreaterThanOrEqual(50))
  for (const file of files) {
    it(`invariants hold across ${file}`, () => {
      const trace = JSON.parse(readFileSync(join(ORACLE, file), 'utf8')) as { steps: Array<{ op: string; state: WireProject }> }
      for (const step of trace.steps) {
        expect(() => checkAllInvariants(step.state), `${file} @ op=${step.op}`).not.toThrow()
      }
    })
  }
})
