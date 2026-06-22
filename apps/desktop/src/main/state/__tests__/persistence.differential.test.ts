// apps/desktop/src/main/state/__tests__/persistence.differential.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalString } from '../canonical'
import { serializeProject } from '../serialize'
import { loadProjectFromJson } from '../persistence'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const ORACLE = join(ROOT, 'oracle')
const posixJoin = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')

describe('Phase 3b persistence: Rust-serialized project.json round-trips through the TS loader (FULL corpus)', () => {
  const files = readdirSync(ORACLE).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    it(`round-trips the final state for ${f}`, () => {
      const oracle = JSON.parse(readFileSync(join(ORACLE, f), 'utf8'))
      const final = oracle.steps[oracle.steps.length - 1].state // Rust's on-disk shape (key-sorted, <TS>-normalized)
      const text = JSON.stringify(final)
      const { project } = loadProjectFromJson(text, { dir: '/ws.vproj', join: posixJoin })
      // The TS loader is an identity over the on-disk shape (reconcile + quick-proxy
      // are no-ops on the corpus): re-serialize must canonical-equal the input.
      expect(canonicalString(serializeProject(project))).toBe(canonicalString(final))
    })
  }
})
