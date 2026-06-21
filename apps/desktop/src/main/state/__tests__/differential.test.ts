// apps/desktop/src/main/state/__tests__/differential.test.ts
//
// Phase 0 EXIT GATE: round-trips every state in every committed oracle trace
// through the TypeScript model + serializer and asserts the canonical form is
// unchanged. Proves the TS model is wire-faithful against real Rust-actor output.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProject, serializeProject } from '../serialize'
import { canonicalString } from '../canonical'

// ESM: __dirname is not available; resolve via import.meta.url instead.
// From src/main/state/__tests__/ → apps/desktop/ is four levels up,
// then down into fixtures/state-corpus/oracle.
const ORACLE = join(
  fileURLToPath(new URL('../../../../fixtures/state-corpus/oracle', import.meta.url)),
)

describe('TS model round-trips real Rust actor states', () => {
  const files = readdirSync(ORACLE).filter((f) => f.endsWith('.json'))

  it('has a non-empty oracle corpus', () => expect(files.length).toBeGreaterThanOrEqual(50))

  for (const file of files) {
    const trace = JSON.parse(readFileSync(join(ORACLE, file), 'utf8')) as {
      steps: Array<{ op: string; state: unknown }>
    }
    it(`round-trips every state in ${file}`, () => {
      for (const step of trace.steps) {
        const round = canonicalString(serializeProject(parseProject(step.state)))
        expect(round, `${file} @ op=${step.op}`).toBe(canonicalString(step.state))
      }
    })
  }
})
