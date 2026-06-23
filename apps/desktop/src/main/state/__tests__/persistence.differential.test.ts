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

describe('persistence: Rust-serialized project.json round-trips through the TS loader (FULL corpus)', () => {
  const files = readdirSync(ORACLE).filter((f) => f.endsWith('.json'))
  // loadProjectFromJson INTENTIONALLY transforms two media fields: clearSessionQuickProxies
  // nulls quick_proxy_path, and reconcileMediaPaths recomputes path_abs from path_rel. The
  // identity assertion below therefore only holds for media whose quick_proxy_path AND path_rel
  // are both null. Sequences that set either field (Phase 3c-i set_media_derivatives /
  // set_media_workspace_paths) exercise those transforms and are unit-gated in
  // persistence.test.ts — skip them here so this stays a pure Rust-writes/TS-reads field-fidelity gate.
  const identityEligible = (final: Record<string, unknown>): boolean => {
    const pool = (final?.media_pool ?? {}) as Record<string, { quick_proxy_path: unknown; path_rel: unknown }>
    return Object.values(pool).every((m) => m.quick_proxy_path == null && m.path_rel == null)
  }
  const checked = files.filter((f) => identityEligible(JSON.parse(readFileSync(join(ORACLE, f), 'utf8')).steps.at(-1).state))
  for (const f of checked) {
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
