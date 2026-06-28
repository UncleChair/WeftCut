# State-Corpus → Property-Based Test Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ~5.2 MB of frozen, Rust-generated state-corpus oracles (which can no longer be regenerated since the Rust state actor was deleted) with a small, code-based test net — property-based invariants + a model-based oracle + a handful of intent examples — that verifies *correctness* rather than byte-identity against a snapshot, then delete the corpus.

**Architecture:** The migration's differential job (prove TS == live Rust) is complete and unrepeatable. We re-aim the deep `oracle/` suite at correctness: metamorphic/algebraic properties (determinism, serialize round-trip, undo-unwind) as the primary oracle (implementation-independent, cannot be tautological); a model-based PBT (fast-check `fc.modelRun`) that predicts exact field values for core timeline ops; structural invariants (overlap/range/autofit/groups) re-derived independently of the production validator; and a few inline intent examples mined from the existing sequences. The three thin layers (`oracle-summary`/`oracle-mcp`/`oracle-prod`) collapse into focused projection/routing tests. The frozen oracle is used once — to validate the new invariants aren't wrong — then deleted (git tag is the archive).

**Tech Stack:** TypeScript, vitest 4.1.7 (`npx vitest run`), fast-check (new dev dep), StrykerJS (new dev dep, validation gate only), Rust `proptest` (new native dev dep, twin task only). Node 22.20.0 via fnm.

## Global Constraints

- **Node 22.20.0 via fnm** — do not switch Node versions; do not `winget install node`.
- **Test runner is vitest**: full suite `npm test` (from `apps/desktop/`) = `vitest run --exclude '**/*.browser.test.ts'`. Single file: `npx vitest run <path>`. Single test: add `-t "<name>"`.
- **All new TS test/source files live under `apps/desktop/`.** Paths below are relative to `apps/desktop/` unless absolute.
- **Anti-tautology rule (load-bearing):** invariant and model code MUST NOT `import` from `src/main/state/validate.ts` or any production validator/mutation that itself enforces the rule being checked. Re-derive every structural rule in the test module. Metamorphic properties (determinism, round-trip, undo-unwind) are exempt because they compare runs, not rules.
- **Determinism in CI:** every `fc.assert` call passes an explicit `{ seed: PBT_SEED, numRuns: PBT_RUNS }`. `PBT_SEED` is a fixed constant; `PBT_RUNS` reads `process.env.WEFTCUT_PBT_RUNS ?? 200` so Stryker can shrink it. Never rely on fast-check's default random seed.
- **Build order before any e2e/native test:** `npm run build:wasm` then `npm run napi:build` if native code changed (the eval WASM and `@weftcut/core` must be current). The twin-PBT tasks need a fresh `build:wasm`. Note: `npm test` runs `build:wasm` first (via `pretest`), but a single-file `npx vitest run <path>` does NOT — run `npm run build:wasm` manually before single-file twin-PBT runs.
- **Rust tests need feature flags:** a bare `cargo build`/`cargo test` FAILS to compile the feature-gated napi callback in the main `native/` crate. Always pass `--features jobs,export,mcp,cloud` (matching `napi:build`). This applies to Task 10.
- **Evergreen docs / comment style:** no phase numbers, dates, or commit hashes in `docs/` or source comments (see `docs/comment-style.md`). This plan file itself is the exception (plans are dated and disposable; delete it once executed).
- **Parallel-session git discipline:** the user edits this same checkout from other sessions. Stage by explicit path (`git add <path>`), never `git add -A`/`.`. Re-run `git status` before each commit and confirm only intended files are staged.
- **Branch:** do all work on a feature branch (e.g. `feat/state-corpus-pbt`), not `main`.

## File Structure

New files (all under `apps/desktop/`):

- `src/main/state/__tests__/pbt/harness.ts` — shared PBT primitives: `freshActor()`, `canonicalSnapshot()`, ref-free target helpers, `PBT_SEED`, `PBT_RUNS`, the `WireProject` types.
- `src/main/state/__tests__/pbt/invariants.ts` — independently re-derived structural invariants over the serialized wire project.
- `src/main/state/__tests__/pbt/invariants.test.ts` — unit tests proving each invariant accepts good states and rejects hand-built bad ones.
- `src/main/state/__tests__/pbt/metamorphic.test.ts` — determinism, serialize round-trip, undo-unwind properties.
- `src/main/state/__tests__/pbt/model.test.ts` — `fc.modelRun` model-based oracle for core timeline ops.
- `src/main/state/__tests__/pbt/invariant-fuzz.test.ts` — broad-op fuzz asserting only invariants + graceful errors.
- `src/main/state/__tests__/pbt/oracle-bridge.test.ts` — runs the new invariants over every frozen oracle state (deleted in the final task).
- `src/main/state/__tests__/intent.examples.test.ts` — inline scenario tests mined from `fixtures/state-corpus/sequences/`.
- `src/main/state/__tests__/summary.projection.test.ts` — replaces `summary.differential.test.ts`.
- `src/main/state/__tests__/mcp.routing.test.ts` — replaces `mcp.differential.test.ts`.
- `src/main/state/__tests__/prod.routing.test.ts` — replaces `commands.differential.test.ts`.
- `src/renderer/render/audio/panGraph.pbt.test.ts` — TS twin-PBT for `panCoeffsAt`.
- `stryker.config.json` — Stryker config (repo-relative to `apps/desktop/`).

Modified:
- `package.json` (devDependencies: fast-check, @stryker-mutator/core, @stryker-mutator/vitest-runner; new `pbt:stryker` script).
- `native/Cargo.toml` (dev-dependency: proptest) + `native/src/audio/envelope.rs` (proptest module).
- `src/main/state/replay.ts` (remove now-dead replay helpers in the final task, only those confirmed unused).

Deleted (final task, after a git tag):
- `fixtures/state-corpus/{oracle,oracle-summary,oracle-mcp,oracle-prod,sequences,sequences-prod,sequences-mcp}/`
- `src/main/state/__tests__/{differential.test.ts,differential.phase2.test.ts,summary.differential.test.ts,commands.differential.test.ts,mcp.differential.test.ts}`
- `fixtures/state-corpus/README.md`

---

## Phase 1 — Build the new net (nothing deleted yet)

### Task 1: PBT harness + fast-check dependency

**Files:**
- Modify: `package.json` (devDependencies)
- Create: `src/main/state/__tests__/pbt/harness.ts`

**Interfaces:**
- Produces: `freshActor(): ReturnType<typeof createActor>`; `canonicalSnapshot(actor): string`; `wireSnapshot(actor): WireProject`; `aRollId(actor)/bRollId(actor): string`; `layerIds(p: WireProject): {id, track, kind, start, end}[]`; constants `PBT_SEED: number`, `PBT_RUNS: number`; types `WireProject`, `WireLayer`, `WireTrack`, `WireGroup`, `WireTransition`.

- [ ] **Step 1: Add fast-check**

Run from `apps/desktop/`:
```bash
npm install -D fast-check
```
Expected: `package.json` devDependencies gains `"fast-check"`. Confirm with `node -e "console.log(require('fast-check/package.json').version)"`.

- [ ] **Step 2: Write the harness**

Create `src/main/state/__tests__/pbt/harness.ts`:
```ts
// Shared primitives for the state-corpus property-based test suite.
// Every fc.assert in this suite passes { seed: PBT_SEED, numRuns: PBT_RUNS }
// so CI is deterministic and Stryker can shrink runs via WEFTCUT_PBT_RUNS.
import { seededGen } from '../../ids'
import { blankProject } from '../../model'
import { createActor } from '../../actor'
import { serializeProject } from '../../serialize'
import { canonicalString } from '../../canonical'

export const PBT_SEED = 0x5747_4354 // "WGCT" — fixed; do not randomize.
export const PBT_RUNS = Number(process.env.WEFTCUT_PBT_RUNS ?? 200)

export interface WireLayer { id: string; t_start_us: number; t_end_us: number; params: { kind: string } }
export interface WireTrack { id: string; layers: WireLayer[] }
export interface WireGroup { id: string; members: string[] }
export interface WireTransition { id: string; from_layer: string; to_layer: string; duration_us: number }
export interface WireProject {
  composition: { duration_us: number; duration_pinned: boolean; fps: { num: number; den: number }; width: number; height: number }
  tracks: WireTrack[]
  groups: WireGroup[]
  transitions: WireTransition[]
}

/** Fresh blank project + actor with seeded ids (#1 A-roll, #2 B-roll, #3 project),
 *  matching the deleted replay_driver setup. Clock is constant so timestamps never
 *  perturb canonical comparison. */
export function freshActor() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  return createActor({ initial, idGen, clock: () => '<TS>' })
}

export function aRollId(actor: ReturnType<typeof createActor>): string { return actor.snapshot().tracks[0].id }
export function bRollId(actor: ReturnType<typeof createActor>): string { return actor.snapshot().tracks[1].id }

export function wireSnapshot(actor: ReturnType<typeof createActor>): WireProject {
  return serializeProject(actor.snapshot()) as unknown as WireProject
}
export function canonicalSnapshot(actor: ReturnType<typeof createActor>): string {
  return canonicalString(serializeProject(actor.snapshot()))
}

/** Flat view of every layer with its owning track id — the unit invariants and
 *  model commands target. */
export function layerIds(p: WireProject): Array<{ id: string; track: string; kind: string; start: number; end: number }> {
  const out: Array<{ id: string; track: string; kind: string; start: number; end: number }> = []
  for (const t of p.tracks) for (const l of t.layers) out.push({ id: l.id, track: t.id, kind: l.params.kind, start: l.t_start_us, end: l.t_end_us })
  return out
}
```

- [ ] **Step 3: Verify it compiles (no test yet)**

Run:
```bash
npm run typecheck
```
Expected: clean (`typecheck` is `tsc -b`; the harness only re-exports existing modules with known signatures). If `seededGen`/`blankProject`/`createActor` import paths are wrong, fix to match `src/main/state/replay.ts` lines 2-6.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/main/state/__tests__/pbt/harness.ts
git commit -m "test(state): add fast-check + PBT harness primitives"
```

---

### Task 2: Structural invariants (independent re-derivation)

**Files:**
- Create: `src/main/state/__tests__/pbt/invariants.ts`
- Test: `src/main/state/__tests__/pbt/invariants.test.ts`

**Interfaces:**
- Consumes: `WireProject` from `harness.ts`.
- Produces: `checkAllInvariants(p: WireProject): void` (throws `InvariantError` on violation); individual `invUniqueLayerIds`, `invLayerRanges`, `invNoUnauthorizedOverlap`, `invDurationAutofit`, `invGroupsWellFormed`; class `InvariantError extends Error`.

- [ ] **Step 1: Write the failing test**

Create `src/main/state/__tests__/pbt/invariants.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { checkAllInvariants, invNoUnauthorizedOverlap, invDurationAutofit, invGroupsWellFormed, InvariantError } from './invariants'
import type { WireProject } from './harness'

const base: WireProject = {
  composition: { duration_us: 1000, duration_pinned: false, fps: { num: 30, den: 1 }, width: 1920, height: 1080 },
  tracks: [{ id: 'tA', layers: [{ id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } }] }],
  groups: [], transitions: [],
}

describe('structural invariants', () => {
  it('accepts a well-formed project', () => expect(() => checkAllInvariants(base)).not.toThrow())

  it('rejects unauthorized same-class overlap', () => {
    const bad: WireProject = { ...base, tracks: [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
      { id: 'l2', t_start_us: 500, t_end_us: 1500, params: { kind: 'Color' } },
    ] }], composition: { ...base.composition, duration_us: 1500 } }
    expect(() => invNoUnauthorizedOverlap(bad)).toThrow(InvariantError)
  })

  it('allows overlap exactly covered by an authorized transition', () => {
    const ok: WireProject = { ...base,
      tracks: [{ id: 'tA', layers: [
        { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
        { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
      ] }],
      transitions: [{ id: 'x', from_layer: 'l1', to_layer: 'l2', duration_us: 200 }],
      composition: { ...base.composition, duration_us: 1800 } }
    expect(() => invNoUnauthorizedOverlap(ok)).not.toThrow()
  })

  it('rejects duration not autofit when unpinned', () => {
    const bad: WireProject = { ...base, composition: { ...base.composition, duration_us: 999, duration_pinned: false } }
    expect(() => invDurationAutofit(bad)).toThrow(InvariantError)
  })

  it('ignores duration when pinned', () => {
    const ok: WireProject = { ...base, composition: { ...base.composition, duration_us: 999, duration_pinned: true } }
    expect(() => invDurationAutofit(ok)).not.toThrow()
  })

  it('rejects a layer in two groups', () => {
    const bad: WireProject = { ...base,
      tracks: [{ id: 'tA', layers: [
        { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
        { id: 'l2', t_start_us: 1000, t_end_us: 2000, params: { kind: 'Color' } },
      ] }],
      groups: [{ id: 'g1', members: ['l1', 'l2'] }, { id: 'g2', members: ['l2'] }],
      composition: { ...base.composition, duration_us: 2000 } }
    expect(() => invGroupsWellFormed(bad)).toThrow(InvariantError)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/state/__tests__/pbt/invariants.test.ts`
Expected: FAIL — `Cannot find module './invariants'`.

- [ ] **Step 3: Write the invariants**

Create `src/main/state/__tests__/pbt/invariants.ts`:
```ts
// Independently re-derived structural invariants over the serialized wire
// project. DELIBERATELY does NOT import src/main/state/validate.ts — asserting
// against the production validator would be tautological. The rules below are a
// fresh statement of the same domain laws (ADR 0005 autofit; linear-NLE overlap;
// group well-formedness), written so a mutation that forgot to call validate, or
// two mutations that interact to break a law, surfaces here.
import type { WireProject, WireLayer } from './harness'

export class InvariantError extends Error {}
function fail(msg: string): never { throw new InvariantError(msg) }

function overlapClass(kind: string): 'audio' | 'visual' { return kind === 'Audio' ? 'audio' : 'visual' }
function pairKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}` }

export function invUniqueLayerIds(p: WireProject): void {
  const seen = new Set<string>()
  for (const t of p.tracks) for (const l of t.layers) {
    if (seen.has(l.id)) fail(`duplicate layer id ${l.id}`)
    seen.add(l.id)
  }
}

export function invLayerRanges(p: WireProject): void {
  for (const t of p.tracks) for (const l of t.layers)
    if (l.t_start_us >= l.t_end_us) fail(`layer ${l.id} has empty/inverted range [${l.t_start_us}, ${l.t_end_us})`)
}

export function invNoUnauthorizedOverlap(p: WireProject): void {
  // Authorized overlap per layer-pair = the geometric overlap of the two
  // transition-linked layers (independently recomputed, not read from validate).
  const idx = new Map<string, WireLayer>()
  for (const t of p.tracks) for (const l of t.layers) idx.set(l.id, l)
  const authorized = new Map<string, number>()
  for (const tr of p.transitions) {
    const a = idx.get(tr.from_layer), b = idx.get(tr.to_layer)
    if (!a || !b) continue
    authorized.set(pairKey(tr.from_layer, tr.to_layer), Math.max(Math.min(a.t_end_us, b.t_end_us) - Math.max(a.t_start_us, b.t_start_us), 0))
  }
  for (const t of p.tracks) {
    for (const cls of ['visual', 'audio'] as const) {
      const lane = t.layers.filter((l) => overlapClass(l.params.kind) === cls).sort((x, y) => x.t_start_us - y.t_start_us)
      // Track the longest-reaching prior layer (a long clip can start before a
      // short one yet still overlap a later layer).
      let prev: WireLayer | null = null
      for (const l of lane) {
        if (prev && l.t_start_us < prev.t_end_us) {
          const overlap = prev.t_end_us - l.t_start_us
          if ((authorized.get(pairKey(prev.id, l.id)) ?? 0) !== overlap)
            fail(`unauthorized ${cls} overlap on track ${t.id}: ${prev.id} & ${l.id} (${overlap}µs)`)
        }
        prev = prev && prev.t_end_us >= l.t_end_us ? prev : l
      }
    }
  }
}

export function invDurationAutofit(p: WireProject): void {
  if (p.composition.duration_pinned) return
  let maxEnd = -1
  for (const t of p.tracks) for (const l of t.layers) if (l.t_end_us > maxEnd) maxEnd = l.t_end_us
  if (maxEnd < 0) return // no layers: autofit baseline is unconstrained here
  if (p.composition.duration_us !== maxEnd)
    fail(`unpinned duration ${p.composition.duration_us} != max layer end ${maxEnd}`)
}

export function invGroupsWellFormed(p: WireProject): void {
  const known = new Set<string>()
  for (const t of p.tracks) for (const l of t.layers) known.add(l.id)
  const seenG = new Set<string>(), member = new Map<string, string>()
  for (const g of p.groups) {
    if (seenG.has(g.id)) fail(`duplicate group id ${g.id}`)
    seenG.add(g.id)
    if (g.members.length < 2) fail(`group ${g.id} below min size (${g.members.length})`)
    for (const m of g.members) {
      if (!known.has(m)) fail(`group ${g.id} references missing layer ${m}`)
      const first = member.get(m)
      if (first) fail(`layer ${m} in two groups (${first}, ${g.id})`)
      member.set(m, g.id)
    }
  }
}

export function checkAllInvariants(p: WireProject): void {
  invUniqueLayerIds(p)
  invLayerRanges(p)
  invNoUnauthorizedOverlap(p)
  invDurationAutofit(p)
  invGroupsWellFormed(p)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/state/__tests__/pbt/invariants.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/state/__tests__/pbt/invariants.ts src/main/state/__tests__/pbt/invariants.test.ts
git commit -m "test(state): independently re-derived structural invariants + their unit tests"
```

---

### Task 3: Metamorphic properties (determinism, round-trip, undo-unwind)

**Files:**
- Create: `src/main/state/__tests__/pbt/metamorphic.test.ts`

**Interfaces:**
- Consumes: `freshActor`, `canonicalSnapshot`, `wireSnapshot`, `aRollId`, `bRollId`, `PBT_SEED`, `PBT_RUNS` from `harness.ts`; `parseProject`, `serializeProject` from `../../serialize`; `canonicalString` from `../../canonical`.
- Produces: a reusable in-file `genOps(actor): fc.Arbitrary<Op[]>`-style generator and `applyOps(actor, ops)` used by Tasks 3 and 5. Define `applyOps` here and export it for reuse.

These three properties are the **primary oracle** — they compare runs, never the production validator, so they cannot be tautological.

- [ ] **Step 1: Write the property test**

Create `src/main/state/__tests__/pbt/metamorphic.test.ts`:
```ts
import { describe, it } from 'vitest'
import fc from 'fast-check'
import { freshActor, canonicalSnapshot, wireSnapshot, aRollId, bRollId, PBT_SEED, PBT_RUNS } from './harness'
import { parseProject, serializeProject } from '../../serialize'
import { canonicalString } from '../../canonical'

// A self-contained op record. Targets layers by index into the CURRENT snapshot
// (resolved at apply time) so no @ref bookkeeping is needed and targets are
// always valid-or-cleanly-rejected.
type Op =
  | { t: 'add'; track: 0 | 1; start: number; len: number }
  | { t: 'move'; layerN: number; track: 0 | 1; start: number }
  | { t: 'trim'; layerN: number; edge: 'start' | 'end'; to: number }
  | { t: 'delete'; layerN: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('add' as const), track: fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, start: fc.integer({ min: 0, max: 9 }).map((n) => n * 100_000), len: fc.integer({ min: 1, max: 9 }).map((n) => n * 100_000) }),
  fc.record({ t: fc.constant('move' as const), layerN: fc.nat({ max: 20 }), track: fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, start: fc.integer({ min: 0, max: 12 }).map((n) => n * 100_000) }),
  fc.record({ t: fc.constant('trim' as const), layerN: fc.nat({ max: 20 }), edge: fc.constantFrom('start', 'end') as fc.Arbitrary<'start' | 'end'>, to: fc.integer({ min: 0, max: 12 }).map((n) => n * 100_000) }),
  fc.record({ t: fc.constant('delete' as const), layerN: fc.nat({ max: 20 }) }),
)

/** Apply ops to a fresh-or-given actor, resolving layer/track targets against
 *  the live snapshot. Ignored if the target index is out of range; rejected
 *  mutations are simply skipped (the actor stays consistent). Returns the actor. */
export function applyOps(actor: ReturnType<typeof freshActor>, ops: Op[]) {
  const tracks = () => [aRollId(actor), bRollId(actor)]
  for (const op of ops) {
    const layers = wireSnapshot(actor).tracks.flatMap((t) => t.layers.map((l) => l.id))
    switch (op.t) {
      case 'add':
        actor.dispatch('add_layer', { track: tracks()[op.track], kind: 'color', t_start_us: op.start, t_end_us: op.start + op.len })
        break
      case 'move':
        if (layers.length) actor.dispatch('move_layer', { layer: layers[op.layerN % layers.length], to_track: tracks()[op.track], t_start_us: op.start, escape_group: false })
        break
      case 'trim':
        if (layers.length) actor.dispatch('trim_layer', { layer: layers[op.layerN % layers.length], edge: op.edge, new_t_us: op.to, escape_group: false })
        break
      case 'delete':
        if (layers.length) actor.dispatch('delete_layer', { layer: layers[op.layerN % layers.length] })
        break
    }
  }
  return actor
}

describe('metamorphic properties (primary oracle)', () => {
  it('determinism: identical op lists yield byte-identical canonical state', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
      const a = canonicalSnapshot(applyOps(freshActor(), ops))
      const b = canonicalSnapshot(applyOps(freshActor(), ops))
      return a === b
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })

  it('serialize round-trip: parse(serialize(s)) is canonical-identical', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
      const actor = applyOps(freshActor(), ops)
      const wire = serializeProject(actor.snapshot())
      return canonicalString(serializeProject(parseProject(wire))) === canonicalString(wire)
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })

  it('undo fully unwinds to the initial blank state (coalescing-proof)', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
      const actor = freshActor()
      const start = canonicalSnapshot(actor)
      applyOps(actor, ops)
      // Undo until the canonical state stops changing (robust to undo coalescing).
      let prev = ''
      for (let i = 0; i < ops.length + 5; i++) {
        const cur = canonicalSnapshot(actor)
        if (cur === prev) break
        prev = cur
        actor.dispatch('undo', {})
      }
      return canonicalSnapshot(actor) === start
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })
})
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run src/main/state/__tests__/pbt/metamorphic.test.ts`
Expected: PASS (3 properties). If the undo property fails, **do not weaken it** — investigate via systematic-debugging; an undo that doesn't unwind is a real bug or a real coalescing edge worth a comment. Capture the failing seed fast-check prints and add a focused regression example to Task 6.

- [ ] **Step 3: Commit**

```bash
git add src/main/state/__tests__/pbt/metamorphic.test.ts
git commit -m "test(state): metamorphic PBT — determinism, serialize round-trip, undo-unwind"
```

---

### Task 4: Model-based oracle for core timeline ops

**Files:**
- Create: `src/main/state/__tests__/pbt/model.test.ts`

**Interfaces:**
- Consumes: `freshActor`, `wireSnapshot`, `aRollId`, `bRollId`, `PBT_SEED`, `PBT_RUNS` from `harness.ts`; `checkAllInvariants` from `./invariants`.
- Produces: nothing imported elsewhere.

The model predicts **exact field values conditional on success**: it never decides whether a mutation is legal (that stays the actor's call, avoiding re-implementing the overlap rule). When the actor returns `ok`, the model asserts the layer landed exactly where intended; when the actor rejects, the model is unchanged and we only require the failure to be a known variant. After every command, the shared invariants must hold.

- [ ] **Step 1: Write the model-based property**

Create `src/main/state/__tests__/pbt/model.test.ts`:
```ts
import { describe, it } from 'vitest'
import fc from 'fast-check'
import { freshActor, wireSnapshot, aRollId, bRollId, PBT_SEED, PBT_RUNS } from './harness'
import { checkAllInvariants } from './invariants'

type Real = ReturnType<typeof freshActor>
interface MLayer { id: string; track: string; start: number; end: number }
interface Model { layers: Map<string, MLayer>; tracks: [string, string] }

const trackOf = (m: Model, i: 0 | 1) => m.tracks[i]
const idsSorted = (m: Model) => [...m.layers.keys()].sort()
function postcheck(real: Real) { checkAllInvariants(wireSnapshot(real)) }

class AddColor implements fc.Command<Model, Real> {
  constructor(readonly track: 0 | 1, readonly start: number, readonly len: number) {}
  check() { return true }
  run(m: Model, r: Real) {
    const res = r.dispatch('add_layer', { track: trackOf(m, this.track), kind: 'color', t_start_us: this.start, t_end_us: this.start + this.len })
    if (res.ok && typeof res.value === 'string') {
      m.layers.set(res.value, { id: res.value, track: trackOf(m, this.track), start: this.start, end: this.start + this.len })
      const live = wireSnapshot(r).tracks.flatMap((t) => t.layers).find((l) => l.id === res.value)!
      if (live.t_start_us !== this.start || live.t_end_us !== this.start + this.len) throw new Error(`add landed wrong: ${live.t_start_us}..${live.t_end_us}`)
    }
    postcheck(r)
  }
  toString() { return `add(t${this.track}, ${this.start}, +${this.len})` }
}

class Move implements fc.Command<Model, Real> {
  constructor(readonly layerN: number, readonly track: 0 | 1, readonly start: number) {}
  check(m: Model) { return m.layers.size > 0 }
  run(m: Model, r: Real) {
    const id = idsSorted(m)[this.layerN % m.layers.size]
    const before = m.layers.get(id)!
    const res = r.dispatch('move_layer', { layer: id, to_track: trackOf(m, this.track), t_start_us: this.start, escape_group: false })
    if (res.ok) {
      const dur = before.end - before.start
      const next = { id, track: trackOf(m, this.track), start: this.start, end: this.start + dur }
      m.layers.set(id, next)
      const live = wireSnapshot(r).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!
      if (live.t_start_us !== next.start || live.t_end_us !== next.end) throw new Error(`move landed wrong: ${live.t_start_us}..${live.t_end_us} expected ${next.start}..${next.end}`)
    }
    postcheck(r)
  }
  toString() { return `move(#${this.layerN}, t${this.track}, ${this.start})` }
}

class Delete implements fc.Command<Model, Real> {
  constructor(readonly layerN: number) {}
  check(m: Model) { return m.layers.size > 0 }
  run(m: Model, r: Real) {
    const id = idsSorted(m)[this.layerN % m.layers.size]
    const res = r.dispatch('delete_layer', { layer: id })
    if (res.ok) {
      m.layers.delete(id)
      const live = wireSnapshot(r).tracks.flatMap((t) => t.layers).some((l) => l.id === id)
      if (live) throw new Error(`delete left layer ${id} present`)
    }
    postcheck(r)
  }
  toString() { return `delete(#${this.layerN})` }
}

class Undo implements fc.Command<Model, Real> {
  check() { return true }
  run(_m: Model, r: Real) { r.dispatch('undo', {}); postcheck(r) }
  toString() { return 'undo' }
}

const tu = (max: number) => fc.integer({ min: 0, max }).map((n) => n * 100_000)
const commands = [
  fc.tuple(fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, tu(9), fc.integer({ min: 1, max: 9 }).map((n) => n * 100_000)).map(([t, s, l]) => new AddColor(t, s, l)),
  fc.tuple(fc.nat({ max: 20 }), fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, tu(12)).map(([n, t, s]) => new Move(n, t, s)),
  fc.nat({ max: 20 }).map((n) => new Delete(n)),
  fc.constant(new Undo()),
]

describe('model-based oracle (exact-field intent on success)', () => {
  it('actor matches the simplified model for add/move/delete/undo', () => {
    fc.assert(fc.property(fc.commands(commands, { maxCommands: 30 }), (cmds) => {
      const setup = () => {
        const real = freshActor()
        const model: Model = { layers: new Map(), tracks: [aRollId(real), bRollId(real)] }
        return { model, real }
      }
      fc.modelRun(setup, cmds)
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })
})
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run src/main/state/__tests__/pbt/model.test.ts`
Expected: PASS. A failure prints a minimal shrunk command list (e.g. `add(...); move(...)`) — that is a real divergence between intended and actual placement; debug with systematic-debugging, do not loosen the field assertions.

- [ ] **Step 3: Commit**

```bash
git add src/main/state/__tests__/pbt/model.test.ts
git commit -m "test(state): model-based PBT oracle for core timeline mutations"
```

---

### Task 5: Broad-op invariant fuzz

**Files:**
- Create: `src/main/state/__tests__/pbt/invariant-fuzz.test.ts`

**Interfaces:**
- Consumes: `freshActor`, `wireSnapshot`, `aRollId`, `bRollId`, `PBT_SEED`, `PBT_RUNS` from `harness.ts`; `checkAllInvariants` from `./invariants`.

The model in Task 4 covers a few ops precisely; this task covers the *breadth* — split, duplicate, groups, transitions, markers — by asserting only that, however they interleave, the invariants never break and every dispatch returns a structured result (never throws). No model, no exact values.

- [ ] **Step 1: Write the fuzz property**

Create `src/main/state/__tests__/pbt/invariant-fuzz.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { freshActor, wireSnapshot, aRollId, bRollId, PBT_SEED, PBT_RUNS } from './harness'
import { checkAllInvariants } from './invariants'

type Op =
  | { t: 'add'; track: 0 | 1; start: number; len: number }
  | { t: 'duplicate'; n: number; off: number }
  | { t: 'split'; n: number; at: number }
  | { t: 'group'; n: number; m: number }
  | { t: 'addTransition'; n: number; m: number; dur: number }
  | { t: 'undo' } | { t: 'redo' }

const tu = (max: number) => fc.integer({ min: 0, max }).map((n) => n * 100_000)
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('add' as const), track: fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, start: tu(9), len: fc.integer({ min: 1, max: 9 }).map((n) => n * 100_000) }),
  fc.record({ t: fc.constant('duplicate' as const), n: fc.nat({ max: 20 }), off: tu(12) }),
  fc.record({ t: fc.constant('split' as const), n: fc.nat({ max: 20 }), at: tu(12) }),
  fc.record({ t: fc.constant('group' as const), n: fc.nat({ max: 20 }), m: fc.nat({ max: 20 }) }),
  fc.record({ t: fc.constant('addTransition' as const), n: fc.nat({ max: 20 }), m: fc.nat({ max: 20 }), dur: fc.integer({ min: 1, max: 5 }).map((x) => x * 100_000) }),
  fc.record({ t: fc.constant('undo' as const) }), fc.record({ t: fc.constant('redo' as const) }),
)

describe('broad-op invariant fuzz', () => {
  it('no op interleaving ever breaks an invariant or throws', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
      const actor = freshActor()
      const tracks = () => [aRollId(actor), bRollId(actor)]
      for (const op of ops) {
        const layers = wireSnapshot(actor).tracks.flatMap((t) => t.layers.map((l) => l.id))
        const pick = (i: number) => layers[i % layers.length]
        let res: { ok: boolean }
        switch (op.t) {
          case 'add': res = actor.dispatch('add_layer', { track: tracks()[op.track], kind: 'color', t_start_us: op.start, t_end_us: op.start + op.len }); break
          case 'duplicate': res = layers.length ? actor.dispatch('duplicate_layer', { layer: pick(op.n), t_offset_us: op.off }) : { ok: true }; break
          case 'split': res = layers.length ? actor.dispatch('split_layer', { layer: pick(op.n), at_t_us: op.at, escape_group: false }) : { ok: true }; break
          case 'group': res = layers.length >= 2 ? actor.dispatch('groups_create', { layers: [pick(op.n), pick(op.m)], label: null, reassign: false }) : { ok: true }; break
          case 'addTransition': res = layers.length >= 2 ? actor.dispatch('add_transition', { from: pick(op.n), to: pick(op.m), duration_us: op.dur }) : { ok: true }; break
          case 'undo': res = actor.dispatch('undo', {}); break
          case 'redo': res = actor.dispatch('redo', {}); break
        }
        // dispatch must always return a structured result, never throw.
        expect(typeof res.ok).toBe('boolean')
        // invariants hold after every step regardless of ok/err.
        checkAllInvariants(wireSnapshot(actor))
      }
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })
})
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run src/main/state/__tests__/pbt/invariant-fuzz.test.ts`
Expected: PASS. A failure means an op combination produced a state that violates a domain law while the actor accepted it — a genuine bug. Debug, don't suppress.

- [ ] **Step 3: Commit**

```bash
git add src/main/state/__tests__/pbt/invariant-fuzz.test.ts
git commit -m "test(state): broad-op invariant fuzz (split/duplicate/group/transition)"
```

---

### Task 6: Inline intent examples mined from the sequences

**Files:**
- Create: `src/main/state/__tests__/intent.examples.test.ts`

**Interfaces:**
- Consumes: `freshActor`, `wireSnapshot`, `aRollId`, `bRollId` from `pbt/harness.ts`.

PBT covers breadth; these capture the *specific intent* each hand-authored sequence existed to pin — the thing a snapshot could never articulate. Mine `fixtures/state-corpus/sequences/` for distinct intents before they are deleted.

- [ ] **Step 1: Identify the intents to capture**

Run, to list candidate sequences and skim their commands:
```bash
ls fixtures/state-corpus/sequences/ | sed 's/.json//' | sort
```
Pick one representative sequence per distinct intent. Target at least these six (find the closest-named sequences and read them with the Read tool):
1. unauthorized overlap is rejected,
2. unpinned composition duration autofits to the last layer end,
3. `fit_composition_to_layers` pins/sets duration,
4. undo precisely restores the pre-op state,
5. group move keeps members aligned / locked-member rejection,
6. split then the two halves are contiguous and non-overlapping.

- [ ] **Step 2: Write the example tests**

Create `src/main/state/__tests__/intent.examples.test.ts`. Each test builds the scenario via `actor.dispatch` and asserts the *intent* (not a full snapshot). Template for two of the six — write all six following this exact shape, reading the mined sequence for the precise inputs:
```ts
import { describe, it, expect } from 'vitest'
import { freshActor, wireSnapshot, aRollId, bRollId } from './pbt/harness'

describe('timeline mutation intent', () => {
  it('rejects an unauthorized same-track overlap (linear-NLE)', () => {
    const a = freshActor()
    const t = aRollId(a)
    const l1 = a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(l1.ok).toBe(true)
    const l2 = a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 })
    expect(l2.ok).toBe(true)
    // moving l2 to overlap l1 with no transition must be rejected
    const moved = a.dispatch('move_layer', { layer: l2.value, to_track: t, t_start_us: 500_000, escape_group: false })
    expect(moved.ok).toBe(false)
  })

  it('autofits unpinned composition duration to the last layer end (ADR 0005)', () => {
    const a = freshActor()
    a.dispatch('add_layer', { track: aRollId(a), kind: 'color', t_start_us: 0, t_end_us: 2_500_000 })
    expect(wireSnapshot(a).composition.duration_us).toBe(2_500_000)
    expect(wireSnapshot(a).composition.duration_pinned).toBe(false)
  })

  // ... write the remaining four intents (fit_composition, undo-restore,
  // group-move-alignment / locked-member rejection, split-contiguity) here,
  // each asserting the specific intent of its mined sequence.
})
```

- [ ] **Step 3: Run to verify they pass**

Run: `npx vitest run src/main/state/__tests__/intent.examples.test.ts`
Expected: PASS (≥6 tests). If an intent assertion fails, that is either a discovered behavior change or a wrong assumption about the sequence — resolve before proceeding.

- [ ] **Step 4: Commit**

```bash
git add src/main/state/__tests__/intent.examples.test.ts
git commit -m "test(state): inline intent examples mined from the corpus sequences"
```

---

## Phase 2 — Validate the new net before cutting the old

### Task 7: Oracle-bridge — new invariants must accept every frozen oracle state

**Files:**
- Create: `src/main/state/__tests__/pbt/oracle-bridge.test.ts`

**Interfaces:**
- Consumes: `checkAllInvariants` from `./invariants`; `WireProject` from `./harness`.

This squeezes the last value out of the dying corpus: the 177×N frozen states are known-good real states. If a new invariant rejects any of them, the invariant is wrong (too strict) — catch that *now*, before deletion. (A genuine violation in a frozen state would mean the old Rust actor emitted a law-breaking state — equally worth knowing.) This test is deleted together with the corpus in Task 13.

- [ ] **Step 1: Write the bridge test**

Create `src/main/state/__tests__/pbt/oracle-bridge.test.ts`:
```ts
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
```
Note: the `ORACLE` relative depth is `../../../../../` (one deeper than `differential.test.ts` because this file sits in `__tests__/pbt/`). Verify by running the test — a wrong path throws `ENOENT` immediately.

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run src/main/state/__tests__/pbt/oracle-bridge.test.ts`
Expected: PASS across all 177 files. If any invariant throws, fix the invariant (it is too strict) — unless investigation shows the frozen state genuinely broke a law, which you must report before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/main/state/__tests__/pbt/oracle-bridge.test.ts
git commit -m "test(state): transitional oracle-bridge — invariants accept all frozen states"
```

---

### Task 8: StrykerJS mutation-testing validation gate

**Files:**
- Modify: `package.json` (devDeps + `pbt:stryker` script)
- Create: `stryker.config.json`

**Interfaces:** none (tooling). Produces a recorded mutation score, the evidence that the new net has teeth.

- [ ] **Step 1: Install Stryker**

Run from `apps/desktop/`:
```bash
npm install -D @stryker-mutator/core @stryker-mutator/vitest-runner
```
Expected: both appear in devDependencies. Confirm the vitest runner supports vitest 4: `npx stryker --version` runs without error.

- [ ] **Step 2: Write the config**

Create `apps/desktop/stryker.config.json`:
```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "testRunner": "vitest",
  "coverageAnalysis": "perTest",
  "concurrency": 4,
  "timeoutMS": 60000,
  "mutate": [
    "src/main/state/mutations/**/*.ts",
    "src/main/state/validate.ts",
    "src/main/state/keyframeEdits.ts",
    "!src/main/state/**/*.test.ts",
    "!src/main/state/**/__tests__/**"
  ],
  "thresholds": { "high": 90, "low": 80, "break": null }
}
```
Add to `package.json` scripts:
```json
"pbt:stryker": "cross-env WEFTCUT_PBT_RUNS=30 stryker run"
```
If `cross-env` is not already a dependency, instead set the env inline in the run command in Step 3 (PowerShell: `$env:WEFTCUT_PBT_RUNS=30; npx stryker run`).

- [ ] **Step 3: Run the gate and record the score**

Run from `apps/desktop/` (PowerShell):
```powershell
$env:WEFTCUT_PBT_RUNS=30; npx stryker run
```
Expected: Stryker mutates `src/main/state/mutations/**` + `validate.ts`, runs the suite per mutant, prints a mutation score. **This is the validation, not a pass/fail CI gate** (`break: null`). Record the score and the list of surviving mutants.

- [ ] **Step 4: Close the holes the survivors reveal**

For each *surviving* mutant in the mutation/validate code, decide: (a) it exposes a real coverage hole → add a focused example test (Task 6 file) or strengthen an invariant; (b) it is an equivalent mutant (no test could kill it) → leave it. Re-run until survivors are only equivalent mutants or an agreed score (target ≥85%) is reached. Do not chase 100%.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json stryker.config.json src/main/state/__tests__/
git commit -m "test(state): StrykerJS validation gate + close coverage holes it surfaced"
```

---

## Phase 3 — Twin PBT (the included enhancement)

The genuine cross-language twin is the *coefficient-lerp outer loop*: TS `panCoeffsAt` (`render/audio/panGraph.ts`) and Rust `pan_coeffs_at` (`native/src/audio/envelope.rs:152`). They share the leaf law (`panCoeff`/`pan_coeffs`, which is one compiled WASM crate and cannot drift), but each independently implements grid-index + lerp. There is no in-process bridge to call Rust from vitest (`pan_coeffs_at` is native-only, not in the WASM leaf), so we pin **both** outer loops to the same documented independent reference — TS via fast-check, Rust via proptest. Drift in either surfaces against the shared spec.

**Shared reference spec (re-derive identically on both sides):** given envelope grid values `v[0..last]` (pan per grid step `stepUs`) and a query `tUs`: `pos = max(tUs,0)/stepUs`; `i = min(floor(pos), last)`; if `i >= last` result is `coeff(v[last])`; else `frac = pos - i`, result is `lerp(coeff(v[i]), coeff(v[i+1]), frac)` componentwise; where `coeff(p)` is the leaf `pan_coeffs(p, channels)`. Single-value envelope (`last == 0`) returns `coeff(v[0])`.

### Task 9: TS twin-PBT for `panCoeffsAt`

**Files:**
- Create: `src/renderer/render/audio/panGraph.pbt.test.ts`

**Interfaces:**
- Consumes: `panCoeffsAt` from `./panGraph`; `panCoeff` from `../../eval`; the `Envelope` shape (`{ values: number[]; stepUs: number }`).

- [ ] **Step 1: Ensure the WASM leaf is current**

Run from `apps/desktop/`: `npm run build:wasm`
Expected: regenerates `src/renderer/eval/evalWasm.generated.ts`.

- [ ] **Step 2: Write the property**

Create `src/renderer/render/audio/panGraph.pbt.test.ts`:
```ts
// Twin-PBT: pins the TS coefficient-lerp outer loop (panCoeffsAt) to an
// independent reference re-derived from the spec in docs/audio.md. The Rust twin
// pan_coeffs_at is pinned to the SAME spec by a proptest in
// native/src/audio/envelope.rs — together they guarantee cross-language parity
// without an in-process bridge. The leaf law (panCoeff) is shared WASM and cannot
// drift, so only the outer loop is fuzzed here.
import { describe, it } from 'vitest'
import fc from 'fast-check'
import { panCoeffsAt } from './panGraph'
import { panCoeff } from '../../eval'

const PBT_SEED = 0x5747_4354
const RUNS = Number(process.env.WEFTCUT_PBT_RUNS ?? 200)

function reference(values: number[], stepUs: number, channels: number, tUs: number): number[] {
  const coeff = (p: number) => [0, 1, 2, 3].map((k) => panCoeff(p, channels, k))
  const last = values.length - 1
  if (last <= 0) return coeff(values[0] ?? 0)
  const pos = Math.max(tUs, 0) / stepUs
  const i = Math.min(Math.floor(pos), last)
  if (i >= last) return coeff(values[last])
  const a = coeff(values[i]), b = coeff(values[i + 1]), frac = pos - i
  return a.map((av, k) => av + (b[k] - av) * frac)
}

describe('twin-PBT: panCoeffsAt matches the independent reference', () => {
  it('agrees for all envelopes / channels / query times', () => {
    fc.assert(fc.property(
      fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 1, maxLength: 8 }),
      fc.constantFrom(10_000, 20_000),
      fc.constantFrom(1, 2),
      fc.integer({ min: -50_000, max: 200_000 }),
      (values, stepUs, channels, tUs) => {
        const got = panCoeffsAt({ values, stepUs } as any, channels, tUs)
        const exp = reference(values, stepUs, channels, tUs)
        for (let k = 0; k < 4; k++) if (Math.abs((got[k] ?? 0) - (exp[k] ?? 0)) > 1e-6) return false
        return true
      },
    ), { seed: PBT_SEED, numRuns: RUNS })
  })
})
```
Note: confirm the `Envelope` field names are `values` and `stepUs` by reading `src/renderer/render/audio/envelope.ts`; adjust the cast if they differ.

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run src/renderer/render/audio/panGraph.pbt.test.ts`
Expected: PASS. A failure prints the shrunk `(values, stepUs, channels, tUs)` — a real outer-loop divergence (off-by-one at a grid boundary, clamp, or lerp direction). Fix `panGraph.ts`, not the reference, unless the reference misreads the spec.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/render/audio/panGraph.pbt.test.ts
git commit -m "test(audio): twin-PBT pins panCoeffsAt to the independent pan-graph spec"
```

---

### Task 10: Rust twin-PBT for `pan_coeffs_at`

**Files:**
- Modify: `native/Cargo.toml` (dev-dependency `proptest`)
- Modify: `native/src/audio/envelope.rs` (add a proptest module near the existing `#[cfg(test)]`)

**Interfaces:**
- Consumes: `pan_coeffs_at`, `Envelope` from the same module; `pan_coeffs` from the eval leaf.

- [ ] **Step 1: Add proptest**

Edit `native/Cargo.toml`, under `[dev-dependencies]` (create the section if absent):
```toml
[dev-dependencies]
proptest = "1"
```
Run: `cargo build --manifest-path native/Cargo.toml --tests --features jobs,export,mcp,cloud` to fetch it. Expected: compiles. (The `--features` flags are mandatory — a bare build fails on the napi callback.)

- [ ] **Step 2: Write the failing-by-construction proptest**

In `native/src/audio/envelope.rs`, inside the existing `#[cfg(test)] mod tests` (or a new one), add — re-deriving the SAME spec as Task 9's TS reference:
```rust
proptest::proptest! {
    #[test]
    fn pan_coeffs_at_matches_reference(
        values in proptest::collection::vec(-1.0f64..=1.0, 1..8),
        step_us in proptest::sample::select(vec![10_000i64, 20_000]),
        channels in proptest::sample::select(vec![1i32, 2]),
        t_us in -50_000i64..200_000,
    ) {
        // Build an Envelope from the generated grid. Use the same constructor the
        // production sampler uses (match the existing test helpers in this file).
        let env = Envelope::from_grid(&values, step_us); // adjust to the real ctor
        let got = pan_coeffs_at(&env, channels, t_us);

        // Independent reference (mirror of panGraph.pbt.test.ts::reference).
        let coeff = |p: f64| crate::eval::pan_coeffs(p, channels); // [f32;4]
        let last = values.len() - 1;
        let exp: [f32; 4] = if last == 0 {
            coeff(values[0])
        } else {
            let pos = (t_us.max(0) as f64) / step_us as f64;
            let i = (pos.floor() as usize).min(last);
            if i >= last { coeff(values[last]) }
            else {
                let (a, b, frac) = (coeff(values[i]), coeff(values[i + 1]), (pos - i as f64) as f32);
                [a[0] + (b[0]-a[0])*frac, a[1] + (b[1]-a[1])*frac, a[2] + (b[2]-a[2])*frac, a[3] + (b[3]-a[3])*frac]
            }
        };
        for k in 0..4 { proptest::prop_assert!((got[k] - exp[k]).abs() < 1e-6, "k={} got={} exp={}", k, got[k], exp[k]); }
    }
}
```
Note: replace `Envelope::from_grid(&values, step_us)` and `crate::eval::pan_coeffs` with the real constructor/path — read the top of `envelope.rs` and `mix.rs:14` (`use crate::audio::envelope::...`) plus how the existing `sample_gain`/`pan_coeffs_at` tests build an `Envelope`. The reference math must match Task 9 exactly.

- [ ] **Step 3: Run to verify it passes**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud pan_coeffs_at_matches_reference`
Expected: PASS. A failure prints a minimal counterexample — a Rust outer-loop divergence from the shared spec (i.e. cross-language drift). Fix `pan_coeffs_at`, not the reference.

- [ ] **Step 4: Commit**

```bash
git add native/Cargo.toml native/Cargo.lock native/src/audio/envelope.rs
git commit -m "test(audio): Rust twin-PBT pins pan_coeffs_at to the shared pan-graph spec"
```

---

## Phase 4 — Collapse the thin layers and delete the corpus

### Task 11: Replace `oracle-summary` differential with projection unit tests

**Files:**
- Create: `src/main/state/__tests__/summary.projection.test.ts`
- (Delete `summary.differential.test.ts` in Task 13.)

**Interfaces:**
- Consumes: `buildProjectSummary` from `../summary`; `freshActor`, `aRollId` from `pbt/harness.ts`; `actor.snapshot()`, `actor.historyStatus()`.

`buildProjectSummary(snapshot, historyStatus, fileExists)` is a pure projection. A few hand-built states pin it precisely; 177 step-by-step snapshots are unnecessary.

- [ ] **Step 1: Read the summary signature and shape**

Read `src/main/state/summary.ts` to confirm `buildProjectSummary` parameters and the `ProjectSummary` fields (track/layer counts, durations, flags). Note the exact field names you will assert.

- [ ] **Step 2: Write the projection tests**

Create `src/main/state/__tests__/summary.projection.test.ts` with 4-6 cases covering: empty project, one layer (counts + duration), a layer on each track, and the `fileExists` branch (missing media flagged). Assert specific `ProjectSummary` fields (use the real names from Step 1):
```ts
import { describe, it, expect } from 'vitest'
import { buildProjectSummary } from '../summary'
import { freshActor, aRollId } from './pbt/harness'

describe('ProjectSummary projection', () => {
  it('projects an empty project', () => {
    const a = freshActor()
    const s = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)
    // assert the real fields, e.g. expect(s.tracks.length).toBe(2)
    expect(s).toBeTruthy()
  })

  it('reflects one added layer in the summary', () => {
    const a = freshActor()
    a.dispatch('add_layer', { track: aRollId(a), kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    const s = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)
    // assert the layer count / duration field the renderer actually consumes
    expect(s).toBeTruthy()
  })
  // ... 2-4 more: per-track layers, fileExists-missing-media branch, history flags.
})
```
Replace the placeholder `expect(s).toBeTruthy()` lines with assertions on the real `ProjectSummary` fields from Step 1 — no `toBeTruthy` filler in the committed test.

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run src/main/state/__tests__/summary.projection.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/state/__tests__/summary.projection.test.ts
git commit -m "test(state): summary projection unit tests (replaces oracle-summary differential)"
```

---

### Task 12: Replace `oracle-mcp` + `oracle-prod` differentials with routing tests

**Files:**
- Create: `src/main/state/__tests__/mcp.routing.test.ts`
- Create: `src/main/state/__tests__/prod.routing.test.ts`
- (Delete `mcp.differential.test.ts` + `commands.differential.test.ts` in Task 13.)

**Interfaces:**
- Consumes: `actor.mcpCall(op, jsonArgs)` and `actor.command(op, wireArgs)`; `freshActor`, `aRollId` from `pbt/harness.ts`. The deep mutation semantics are already covered by Phase 1 — these test only the *adapter*: arg parsing and routing to the right mutation.

- [ ] **Step 1: Write the MCP routing tests**

Create `src/main/state/__tests__/mcp.routing.test.ts`. For a handful of representative tools, assert: a valid call routes and succeeds (state changes the expected way), and a malformed-args call returns a structured error envelope (not a throw). Example:
```ts
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId } from './pbt/harness'

describe('MCP adapter routing', () => {
  it('routes add_color_layer and returns a layer id', () => {
    const a = freshActor()
    const r = a.mcpCall('add_color_layer', JSON.stringify({ track: aRollId(a), t_start_us: 0, t_end_us: 1_000_000 }))
    expect(r.ok).toBe(true)
  })
  it('returns a structured error for malformed args (no throw)', () => {
    const a = freshActor()
    const r = a.mcpCall('add_color_layer', '{"track": 123}')
    expect(r.ok).toBe(false)
  })
  // ... 3-5 more representative tools (move/trim/group/marker), reading
  // src/main/state/mcp-commands.ts for exact tool names + arg shapes.
})
```

- [ ] **Step 2: Write the production routing tests**

Create `src/main/state/__tests__/prod.routing.test.ts`, same shape but via `actor.command(op, wireArgs)`, reading `src/main/state/commands.ts` (`PRODUCTION_OPS`) for the op names + wire arg shapes. Cover a valid route + a parse-rejection per a couple of ops.

- [ ] **Step 3: Run both**

Run: `npx vitest run src/main/state/__tests__/mcp.routing.test.ts src/main/state/__tests__/prod.routing.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/state/__tests__/mcp.routing.test.ts src/main/state/__tests__/prod.routing.test.ts
git commit -m "test(state): MCP + production adapter routing tests (replace oracle-mcp/prod differentials)"
```

---

### Task 13: Tag, delete the corpus + obsolete tests, prune dead replay code

**Files:**
- Delete: `fixtures/state-corpus/` (entire tree) and its `README.md`
- Delete: `src/main/state/__tests__/{differential.test.ts, differential.phase2.test.ts, summary.differential.test.ts, commands.differential.test.ts, mcp.differential.test.ts}` and `src/main/state/__tests__/pbt/oracle-bridge.test.ts`
- Modify: `src/main/state/replay.ts` (remove only confirmed-dead exports)

- [ ] **Step 1: Tag the pre-deletion state (archive)**

Run from repo root:
```bash
git tag state-corpus-pbt-pre-delete
```
This is the recoverable archive — git is the storage, per the project's evergreen convention. (The pre-Phase-4b Rust-actor tag `state-corpus-frozen-pre-phase4b` already exists for the even-older state.)

- [ ] **Step 2: Confirm replay helpers are dead before removing them**

Run: `npx grep`-equivalent (use the Grep tool) for each export of `replay.ts` (`replaySequence`, `replaySummaries`, `replayMcpSequence`, `replayProductionSequence`, `sequenceIsSupported`, `productionSequenceIsSupported`, `mcpSequenceIsSupported`) across `src/` and `e2e/`, EXCLUDING the differential test files being deleted and `replay.test.ts`.
Expected: only the about-to-be-deleted tests reference them. Anything still referenced (e.g. by `replay.test.ts` or production code) STAYS — remove only confirmed-dead functions. If `replay.test.ts` is the sole remaining consumer and only tested the now-deleted path, delete `replay.test.ts` too; otherwise keep it.

- [ ] **Step 3: Delete the corpus and obsolete tests**

Run from `apps/desktop/`:
```bash
git rm -r fixtures/state-corpus
git rm src/main/state/__tests__/differential.test.ts src/main/state/__tests__/differential.phase2.test.ts src/main/state/__tests__/summary.differential.test.ts src/main/state/__tests__/commands.differential.test.ts src/main/state/__tests__/mcp.differential.test.ts src/main/state/__tests__/pbt/oracle-bridge.test.ts
```
Then remove the confirmed-dead exports from `src/main/state/replay.ts` (per Step 2) with the Edit tool.

- [ ] **Step 4: Verify the whole suite is green without the corpus**

Run from `apps/desktop/`:
```bash
npm test
npm run typecheck
```
Expected: PASS — no test references the deleted fixtures; `typecheck` clean (no dangling imports of removed replay exports). Fix any dangling reference before committing.

- [ ] **Step 5: Commit**

```bash
git add -u
git status   # confirm ONLY intended deletions/edits are staged (parallel-session discipline)
git commit -m "test(state): retire frozen state-corpus — PBT + invariants + examples replace it"
```

---

## Self-Review

**Spec coverage** (against the grilling consensus):
- Purpose = correctness/invariant verification → Tasks 2-5 ✓
- One deep, three thin → deep PBT (Tasks 3-5), thin summary/mcp/prod (Tasks 11-12) ✓
- JSON corpus retired → Task 13 ✓
- Metamorphic-first + structural-independent → Task 3 (primary) + Task 2 (re-derived, no `validate.ts` import) ✓
- Model-based generator → Task 4 (`fc.modelRun`) ✓
- Scope = state-corpus only; goldens + e2e untouched → no task touches `*.golden.*`, `e2e/`, or the math goldens ✓
- Twin-PBT included → Tasks 9-10 ✓
- Phased build → validate → delete → Phases 1/2/4 ordering; corpus deleted only in Task 13, after bridge (Task 7) + Stryker (Task 8) ✓
- Manual + automated fault validation → Task 8 (Stryker) + invariants' bad-state rejection (Task 2) ✓

**Placeholder scan:** Task 6 and Task 11 contain intentionally-marked "write the remaining N following this shape" / "replace the toBeTruthy filler" instructions with a concrete template and the exact source files to read — these are bounded mining/assertion tasks, not open-ended TODOs. Task 10 and Task 9 flag the two real-name confirmations (`Envelope` ctor/fields, `pan_coeffs` path) the implementer must verify against source; all math is fully specified.

**Type consistency:** `WireProject`/`WireLayer` defined in `harness.ts` (Task 1), consumed by Tasks 2, 7. `checkAllInvariants` defined in Task 2, consumed by Tasks 4, 5, 7. `applyOps` defined+exported in Task 3. `freshActor`/`wireSnapshot`/`canonicalSnapshot`/`aRollId`/`bRollId`/`PBT_SEED`/`PBT_RUNS` defined in Task 1, used throughout. The reference pan math is byte-identical between Task 9 (TS) and Task 10 (Rust).
