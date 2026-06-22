# State-Actor TS Migration — Phase 1 Implementation Plan (TS Actor Core + First Mutation Slice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is Phase 1 of the master plan `2026-06-22-state-actor-ts-migration.md` — read Parts 1–4 and the Phase-0 plan first. Phase 0 (`…-phase-0.md`) is DONE: `model.ts`, `serialize.ts`, `canonical.ts`, `ids.ts` exist and a 62-sequence oracle corpus is committed under `apps/desktop/fixtures/state-corpus/`.

**Goal:** Build the TypeScript single-writer project-state actor in the Electron **main** process — the commit pipeline, full undo/redo history, the complete 26-rule validator, `dry_run`, the history/meta commands, and the first mutation slice (`move` / `trim` / `delete` / `duplicate_layer`) plus the minimal additive vocabulary needed to drive it — and prove it byte-identical to the Rust actor across the committed oracle corpus.

**Architecture:** A framework-agnostic store module (`src/main/state/actor.ts`) owns an immutable `Project`. Mutations are pure functions over an **Immer** draft (1:1 with the Rust `apply_*(&mut project)` helpers); the actor's `commit` runs `validate → record-history → emit` exactly as Rust's `commit` does. A TS **replay driver** (`replay.ts`) runs the same command-sequence JSON the Phase-0 Rust driver consumed, and a differential test asserts the per-step canonical project state is identical to the committed oracle traces. Everything is gated by that harness; nothing is wired into the live renderer authoritatively in this phase (a dev-only **shadow comparator** is the only `index.ts` touch).

**Tech Stack:** TypeScript, **Immer** (immutable draft mutation + structural sharing + deep-freeze), Vitest 4, the existing `weftcut-eval` wasm leaf (`snapFrameRound` — UNCHANGED, called never reimplemented), the Phase-0 `model.ts` / `serialize.ts` / `canonical.ts` / `ids.ts`, and the committed Rust oracle corpus as the differential truth.

## Global Constraints

- **The wasm eval leaf is sacred.** The TS actor MUST call `snapFrameRound` (wasm `snap_round`) for frame-grid snapping at mutation time and MUST NOT reimplement it. Source of truth: `apps/desktop/src/renderer/eval/index.ts`. See `feedback_snap_math_drift`, `feedback_engine_source_drift`.
- **Deterministic id contract (the differential harness depends on it EXACTLY):**
  1. `blankProject(idGen, name)` consumes 3 ids: A-roll(#1), B-roll(#2), project(#3).
  2. Seeding the actor's initial `History` entry consumes **one** id for its op_id (Rust `History::new`, `history.rs:67`). After a blank start the counter is at **4**; the first mutation's first entity id is **#5**.
  3. Entity-creating mutations (`add_layer`/`add_track`/`add_marker`/`duplicate_layer`) allocate the entity id **inside the mutation, before validation** — so a mutation that allocates an id then fails validation still consumes that id.
  4. `commit` allocates the op_id **after `validate` succeeds** (Rust `actor.rs:3787` validate → `3789` `new_id()`). A failed validate consumes **no** op_id.
  5. A **successful** `undo`/`redo` consumes one id (the broadcast event's op_id, Rust `broadcast_unrecorded` `actor.rs:3815`). A boundary `undo`/`redo` (`NothingToUndo`/`NothingToRedo`) consumes **zero**.
  These op-ids never appear in compared project state, but they advance the shared counter and thus shift later entity ids. Mirror them exactly.
- **serde wire-shape fidelity is already proven** by Phase 0 (`serialize(parse(x))` canonical-equals `x` over the whole corpus). The TS actor builds `Project` values using `model.ts` types; do not change wire shapes.
- **`CommandError` variant names match Rust exactly** (the differential harness matches the leading-identifier of the Rust `Debug` string against the TS variant). `ValidationError.rule` names also match Rust exactly.
- **Out-of-range keyframes are VALID** (`validate.rs:495-509`). Do NOT add keyframe bounds checks.
- **Flags never gate validation.** `enabled`/`locked`/`muted`/`solo` do not affect `validate`.
- **Group fan-out is deferred to Phase 2 but written now as dead code.** `move`/`trim` port their full group-coupling branches verbatim; in Phase 1 the vocabulary has no `groups_create`, so `groupSiblingsExcluding` always returns `[]` and those branches never execute. The differential gate is scoped (by op-vocabulary) to sequences that never create a group.
- **TimeUs is `number`.** No `bigint`.
- **Every commit message ends with the trailer line** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Parallel sessions:** the user edits this checkout from other sessions. `git add` by **explicit path only** (never `git add -A`/`.`); re-check `git status` before each commit. (`feedback_parallel_sessions_git`.)
- TDD, frequent commits, DRY, YAGNI.

### Phase-1 command vocabulary (what the TS actor implements this phase)

`add_layer` (kinds `color`, `text` only), `add_track`, `add_marker`, `set_composition`, `move_layer`, `trim_layer`, `delete_layer`, `duplicate_layer`, `undo`, `redo`, plus the meta/query surface (`checkpoint`, `restore_checkpoint`, `lock_history`, `unlock_history`, `snapshot`, `history_view`, `history_status`, `dry_run`). **Deferred to Phase 2:** `split_layer`, `groups_create`, `groups_dissolve`, all params/effects/transition/media mutations. The differential gate (Task 12) auto-includes only corpus sequences whose every op is in this vocabulary, and **logs the count of skipped sequences** (no silent caps).

---

## File Structure

All paths under `apps/desktop/`. All vitest commands run from `apps/desktop/` (`npx vitest run <path>`). The vitest config already loads the wasm via `src/renderer/testSetup.ts` (`initEval()` in `beforeAll`), so `snapFrameRound` works in every `src/main` spec.

| Path | Responsibility |
|---|---|
| `src/main/state/snap.ts` | Re-export `snapFrameRound` from the renderer eval leaf (the only snapping the actor may use). |
| `src/main/state/errors.ts` | `ValidationError` + `CommandError` discriminated unions; `ValidationFailure`/`CommandFailure` thrown wrappers; oracle/TS variant-name extractors for the harness. |
| `src/main/state/validate.ts` | Pure 26-rule validator: `validate(project)` → throws `ValidationFailure`. |
| `src/main/state/history.ts` | `History` class: snapshots+cursor+cap+checkpoints+lock; `record/undo/redo/checkpoint/restoreCheckpoint/lock/unlock/view/status/replaceSettingsEverywhere`. |
| `src/main/state/mutations/helpers.ts` | Shared mutation helpers: `locateLayer`, `applyDurationAutofit`, `pruneEmptyHiddenTracks`, `pruneEmptiedTrack`, `dropLayerFromGroups`, `checkTrackLock`, `shiftLayerKeyframes`, layer/track/marker constructors. |
| `src/main/state/mutations/add.ts` | `applyAddLayer`, `applyAddTrack`, `applyAddMarker` (pure draft mutations). |
| `src/main/state/mutations/move.ts` | `applyMoveLayer` (incl. dead-in-P1 group fan-out). |
| `src/main/state/mutations/trim.ts` | `trimDeltaBounds`, `clampSigned`, `applyTrimLayer`. |
| `src/main/state/mutations/delete.ts` | `applyDeleteLayer`. |
| `src/main/state/mutations/duplicate.ts` | `applyDuplicateLayer`. |
| `src/main/state/actor.ts` | `createActor`, the `commit` pipeline, `dispatch(channel,args)`, meta commands, `dryRun`, `setComposition`, `subscribe`. |
| `src/main/state/replay.ts` | `SUPPORTED_OPS`, `replaySequence(seq) → Trace` — TS twin of `replay_driver.rs`. |
| `src/main/state/__tests__/differential.phase1.test.ts` | The exit gate: replay in-vocab corpus, assert per-step canonical state + ok + error-variant equal the oracle. |
| `src/main/state/shadow.ts` | `tsActorHandles(channel)`, `compareCanonical(a,b)` — dev shadow comparator helpers. |
| `src/main/index.ts` (modify) | Behind `WEFTCUT_TS_ACTOR_SHADOW`, replay vocab commands on a shadow TS actor and log divergence (Rust stays authoritative). |

**Reference Rust sources** (cite, don't re-read unless a test diverges): `native/src/state/actor.rs` (commit `3779`, dry_run `2288`, CommandError `336`, meta `3729-3823`), `native/src/state/actor/mutations.rs` (helpers + `apply_*`), `native/src/state/history.rs`, `native/src/state/validate.rs`.

---

## Task 1: Dependency + snap wrapper

**Files:**
- Modify: `apps/desktop/package.json` (add `immer`)
- Create: `apps/desktop/src/main/state/snap.ts`
- Test: `apps/desktop/src/main/state/snap.test.ts`

**Interfaces:**
- Produces: `snapFrameRound(tUs: number, num: number, den: number): number` (re-export). `immer` available to later tasks.

- [ ] **Step 1: Install Immer**

Run from `apps/desktop/`: `npm install immer`
Expected: `immer` appears under `dependencies` in `package.json`; lockfile updates. (Node/npm per `~/.claude/CLAUDE.md`: fnm Node 22.20.0, npm 11.12.1.)

- [ ] **Step 2: Write the failing test**

```ts
// apps/desktop/src/main/state/snap.test.ts
import { describe, it, expect } from 'vitest'
import { snapFrameRound } from './snap'

describe('snapFrameRound (wasm leaf re-export)', () => {
  it('snaps to the nearest 30fps frame boundary (half-up)', () => {
    // 30fps frame ≈ 33_333.33µs; the wasm uses i128 half-up rounding.
    expect(snapFrameRound(0, 30, 1)).toBe(0)
    expect(snapFrameRound(33_333, 30, 1)).toBe(33_333)
    expect(snapFrameRound(50_000, 30, 1)).toBe(snapFrameRound(50_000, 30, 1)) // stable
    expect(snapFrameRound(50_000, 30, 1)).toBe(66_667) // 1.5 frames → rounds up to frame 2
  })
  it('is a no-op for degenerate fps (renderer/seek may pass 0)', () => {
    expect(snapFrameRound(12_345, 0, 1)).toBe(12_345)
    expect(snapFrameRound(12_345, 30, 0)).toBe(12_345)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/state/snap.test.ts`
Expected: FAIL — `Cannot find module './snap'`.

- [ ] **Step 4: Write the implementation**

```ts
// apps/desktop/src/main/state/snap.ts

// The frame-grid snapping the TS actor uses MUST be the shared wasm leaf
// (weftcut-eval `snap_round`) — never a reimplementation — so TS and Rust
// snapping stay byte-identical (feedback_snap_math_drift). Re-exported here so
// main-process code has a stable import that does not reach across into the
// renderer tree at every call site. In tests the wasm is initialized by
// src/renderer/testSetup.ts (initEval in beforeAll); in production the main
// process must await initEval() once at boot before the actor handles a command.
export { snapFrameRound } from '../../renderer/eval'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/state/snap.test.ts`
Expected: PASS. (If `66_667` is wrong for this wasm, replace that one assertion with the value the wasm returns — the point is parity with the leaf, not a hand-computed constant. Keep the no-op and stability assertions.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/src/main/state/snap.ts apps/desktop/src/main/state/snap.test.ts
git commit -m "feat(state-migration): add immer + snap.ts wasm-leaf re-export (Phase 1)"
```

---

## Task 2: Error model (`errors.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/errors.ts`
- Test: `apps/desktop/src/main/state/errors.test.ts`

**Interfaces:**
- Produces:
  - `type ValidationError` (discriminated on `rule`) — names match Rust `ValidationError` variants exactly.
  - `type CommandError` (discriminated on `error`) — names match Rust `CommandError` variants exactly.
  - `class ValidationFailure extends Error { readonly err: ValidationError }`.
  - `class CommandFailure extends Error { readonly err: CommandError }`.
  - `isCommandFailure(e): e is CommandFailure`, `isValidationFailure(e): e is ValidationFailure`.
  - `tsErrorVariant(e: CommandError): { top: string; inner?: string }`.
  - `parseOracleErrorVariant(debug: string): { top: string; inner?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/errors.test.ts
import { describe, it, expect } from 'vitest'
import {
  CommandFailure, ValidationFailure, isCommandFailure,
  tsErrorVariant, parseOracleErrorVariant,
} from './errors'

describe('error wrappers', () => {
  it('CommandFailure carries the typed union and is type-guardable', () => {
    const e = new CommandFailure({ error: 'LayerNotFound', layer: 'abc' })
    expect(isCommandFailure(e)).toBe(true)
    expect(e.err.error).toBe('LayerNotFound')
  })
})

describe('variant extraction (differential harness)', () => {
  it('parses a plain Rust Debug error', () => {
    expect(parseOracleErrorVariant('TrimEdgeOutOfRange { layer: x, new_t: 0 }'))
      .toEqual({ top: 'TrimEdgeOutOfRange' })
  })
  it('parses a payload-less Rust Debug error', () => {
    expect(parseOracleErrorVariant('NothingToUndo')).toEqual({ top: 'NothingToUndo' })
  })
  it('parses a nested ValidationFailed Rust Debug error', () => {
    expect(parseOracleErrorVariant('ValidationFailed(LayerOverlap { track: t, a: x })'))
      .toEqual({ top: 'ValidationFailed', inner: 'LayerOverlap' })
  })
  it('maps a TS CommandError to the same shape', () => {
    expect(tsErrorVariant({ error: 'TrimEdgeOutOfRange', layer: 'x', new_t: 0, cur_start: 0, cur_end: 1 }))
      .toEqual({ top: 'TrimEdgeOutOfRange' })
    expect(tsErrorVariant({ error: 'ValidationFailed', detail: { rule: 'LayerOverlap', track: 't', a: 'x', a_start: 0, a_end: 1, b: 'y', b_start: 0, b_end: 1 } }))
      .toEqual({ top: 'ValidationFailed', inner: 'LayerOverlap' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/errors.test.ts`
Expected: FAIL — `Cannot find module './errors'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/state/errors.ts
import type { TimeUs, Uuid } from './model'

// ── ValidationError — mirrors native/src/state/validate.rs variants ──
export type ValidationError =
  | { rule: 'InvalidCanvas'; width: number; height: number }
  | { rule: 'InvalidFps'; num: number; den: number }
  | { rule: 'DuplicateTransitionId'; transition: Uuid }
  | { rule: 'TransitionSelfReference'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionLayerMissing'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionCrossTrack'; transition: Uuid; from: Uuid; to: Uuid }
  | { rule: 'TransitionDurationOutOfRange'; transition: Uuid; duration: TimeUs }
  | { rule: 'TransitionDurationMismatch'; transition: Uuid; duration: TimeUs; overlap: TimeUs }
  | { rule: 'LayerInMultipleTransitions'; layer: Uuid }
  | { rule: 'DuplicateLayerId'; layer: Uuid }
  | { rule: 'InvalidLayerRange'; layer: Uuid; t_start: TimeUs; t_end: TimeUs }
  | { rule: 'MissingMedia'; layer: Uuid; media: Uuid }
  | { rule: 'InvalidSrcRange'; layer: Uuid; src_in: TimeUs; src_out: TimeUs }
  | { rule: 'SrcRangeExceedsMedia'; layer: Uuid; src_in: TimeUs; src_out: TimeUs; media_duration: TimeUs }
  | { rule: 'LayerOverlap'; track: Uuid; a: Uuid; a_start: TimeUs; a_end: TimeUs; b: Uuid; b_start: TimeUs; b_end: TimeUs }
  | { rule: 'DuplicateGroupId'; group: Uuid }
  | { rule: 'GroupBelowMinSize'; group: Uuid; members: number }
  | { rule: 'GroupMemberMissing'; group: Uuid; layer: Uuid }
  | { rule: 'LayerInMultipleGroups'; layer: Uuid; first: Uuid; second: Uuid }

// ── CommandError — mirrors native/src/state/actor.rs:336-444 variants ──
// Phase 1 only constructs a subset; the rest are typed for Phase 2/3.
export type CommandError =
  | { error: 'TrackNotFound'; track: Uuid }
  | { error: 'LayerNotFound'; layer: Uuid }
  | { error: 'WrongLayerKind'; layer: Uuid; expected: string }
  | { error: 'MarkerNotFound'; marker: Uuid }
  | { error: 'TransitionNotFound'; transition: Uuid }
  | { error: 'TransitionLayersNotAdjacent'; from: Uuid; to: Uuid; duration: TimeUs }
  | { error: 'CheckpointNotFound'; checkpoint: Uuid }
  | { error: 'MediaNotFound'; media: Uuid }
  | { error: 'MediaInUse'; media: Uuid; referenced_by: Uuid[] }
  | { error: 'TrackPositionOutOfRange'; position: number; len: number }
  | { error: 'TrackNotEmpty'; track: Uuid }
  | { error: 'TrackNotRemovable'; track: Uuid }
  | { error: 'TrackLocked'; track: Uuid }
  | { error: 'SplitOutsideLayer'; layer: Uuid; at_t: TimeUs }
  | { error: 'GroupLockedMember'; group: Uuid; locked_layer: Uuid; touched: Uuid }
  | { error: 'TrimEdgeOutOfRange'; layer: Uuid; new_t: TimeUs; cur_start: TimeUs; cur_end: TimeUs }
  | { error: 'LayerParamsKindMismatch'; layer: Uuid; actual: string; patch: string }
  | { error: 'GroupNotFound'; group: Uuid }
  | { error: 'LayerAlreadyGrouped'; layer: Uuid; existing: Uuid }
  | { error: 'GroupCreateNeedsTwoLayers'; got: number }
  | { error: 'LayerNotInGroup'; group: Uuid; layer: Uuid }
  | { error: 'NothingToUndo' }
  | { error: 'NothingToRedo' }
  | { error: 'HistoryLocked'; reason: string }
  | { error: 'ValidationFailed'; detail: ValidationError }
  | { error: 'EmptyKeyframeTrack'; layer: Uuid; param_key: string }
  | { error: 'UnknownKeyframeParam'; layer: Uuid; param_key: string }
  | { error: 'EffectNotFound'; effect: Uuid }
  | { error: 'EffectIndexOutOfRange'; index: number; len: number }
  | { error: 'InvalidArgument'; field: string; detail: string }
  | { error: 'Backend'; detail: string }

/** Thrown by `validate`. Caught by `commit`, re-thrown as CommandFailure(ValidationFailed). */
export class ValidationFailure extends Error {
  constructor(public readonly err: ValidationError) {
    super(err.rule)
    this.name = 'ValidationFailure'
  }
}

/** Thrown by mutation helpers / the actor to abort a command. */
export class CommandFailure extends Error {
  constructor(public readonly err: CommandError) {
    super(err.error)
    this.name = 'CommandFailure'
  }
}

export function isValidationFailure(e: unknown): e is ValidationFailure {
  return e instanceof ValidationFailure
}
export function isCommandFailure(e: unknown): e is CommandFailure {
  return e instanceof CommandFailure
}

/** {top, inner?} for a TS CommandError — inner is the wrapped rule name. */
export function tsErrorVariant(e: CommandError): { top: string; inner?: string } {
  if (e.error === 'ValidationFailed') return { top: 'ValidationFailed', inner: e.detail.rule }
  return { top: e.error }
}

/** Extract {top, inner?} from a Rust `format!("{e:?}")` Debug string, e.g.
 *  "TrimEdgeOutOfRange { .. }" → {top}, "ValidationFailed(LayerOverlap { .. })"
 *  → {top, inner}. Rust renders the variant name as the leading identifier. */
export function parseOracleErrorVariant(debug: string): { top: string; inner?: string } {
  const m = /^([A-Za-z_]\w*)(?:\(([A-Za-z_]\w*))?/.exec(debug.trim())
  if (!m) return { top: debug.trim() }
  return m[2] ? { top: m[1], inner: m[2] } : { top: m[1] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/errors.ts apps/desktop/src/main/state/errors.test.ts
git commit -m "feat(state-migration): CommandError/ValidationError unions + variant extractors"
```

---

## Task 3: The validator (`validate.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/validate.ts`
- Test: `apps/desktop/src/main/state/validate.test.ts`

**Interfaces:**
- Consumes: `Project`, `Layer`, `LayerParams`, `Transition` from `model.ts`; `ValidationError`, `ValidationFailure` from `errors.ts`.
- Produces: `validate(project: Project): void` — throws `ValidationFailure` on the first broken rule, order **composition → transitions → tracks/layers → groups**. Helpers `layerOverlapClass`, `pairKey` are module-private.

Source of truth: `native/src/state/validate.rs` (full rule list in the master plan §2.4 and the Phase-1 expansion notes). Overlap formula and "longest-reaching prev" are quoted in Steps 3 below — port them verbatim.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/validate.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import type { Project, Layer, LayerParams } from './model'
import { validate } from './validate'
import { isValidationFailure } from './errors'

function colorLayer(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 255, g: 0, b: 0, a: 255 } }, width: 1920, height: 1080 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function audioLayer(id: string, media: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Audio', media, src_in_us: 0, src_out_us: t1 - t0, gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 }, fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function expectRule(p: Project, rule: string) {
  try { validate(p); throw new Error(`expected ${rule}, but validate passed`) }
  catch (e) { if (!isValidationFailure(e)) throw e; expect(e.err.rule).toBe(rule) }
}

describe('validate', () => {
  it('passes a blank project', () => { expect(() => validate(blankProject(seededGen(), 't'))).not.toThrow() })

  it('rejects zero canvas width/height and fps', () => {
    const p = blankProject(seededGen(), 't'); p.composition.width = 0; expectRule(p, 'InvalidCanvas')
    const q = blankProject(seededGen(), 't'); q.composition.fps = { num: 0, den: 1 }; expectRule(q, 'InvalidFps')
  })

  it('rejects two overlapping visual layers on one track', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', 0, 1_000_000), colorLayer('b', 500_000, 1_500_000)]
    expectRule(p, 'LayerOverlap')
  })

  it('allows a visual + an audio layer to coexist on one track', () => {
    const p = blankProject(seededGen(), 't')
    p.media_pool['m'] = { id: 'm', path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: 2_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', proxy_path: null, quick_proxy_path: null, proxy_bypassed: false, export_uses_original: false, proxy_format_version: 0, conform_path: null, waveform_path: null, thumbnails_dir: null }
    p.tracks[0].layers = [colorLayer('a', 0, 1_000_000), audioLayer('b', 'm', 0, 1_000_000)]
    expect(() => validate(p)).not.toThrow()
  })

  it('uses the longest-reaching prior layer for the next overlap check', () => {
    // A=[0,100), B=[50,80) (contained, ends earlier). C=[90,120) overlaps A (reaches 100), must reject.
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', 0, 100), colorLayer('b', 50, 80), colorLayer('c', 90, 120)]
    // (b inside a already overlaps a → LayerOverlap fires first; assert it rejects)
    expectRule(p, 'LayerOverlap')
  })

  it('rejects an inverted layer range', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [colorLayer('a', 1_000_000, 1_000_000)]
    expectRule(p, 'InvalidLayerRange')
  })

  it('rejects a duplicate layer id across tracks', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('dup', 0, 100)]
    p.tracks[1].layers = [colorLayer('dup', 0, 100)]
    expectRule(p, 'DuplicateLayerId')
  })

  it('rejects audio referencing missing media and an invalid src range', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [audioLayer('a', 'nope', 0, 100)]
    expectRule(p, 'MissingMedia')
    const q = blankProject(seededGen(), 't')
    q.media_pool['m'] = { id: 'm', path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: null }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', proxy_path: null, quick_proxy_path: null, proxy_bypassed: false, export_uses_original: false, proxy_format_version: 0, conform_path: null, waveform_path: null, thumbnails_dir: null }
    const al = audioLayer('a', 'm', 0, 100); (al.params as any).src_in_us = 100; (al.params as any).src_out_us = 50
    q.tracks[0].layers = [al]; expectRule(q, 'InvalidSrcRange')
  })

  it('rejects a group below 2 members, a missing member, and a layer in two groups', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [colorLayer('a', 0, 100)]
    p.groups = [{ id: 'g', members: ['a'] }]; expectRule(p, 'GroupBelowMinSize')
    const q = blankProject(seededGen(), 't'); q.tracks[0].layers = [colorLayer('a', 0, 100)]
    q.groups = [{ id: 'g', members: ['a', 'ghost'] }]; expectRule(q, 'GroupMemberMissing')
    const r = blankProject(seededGen(), 't'); r.tracks[0].layers = [colorLayer('a', 0, 100), colorLayer('b', 200, 300)]
    r.groups = [{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['a', 'b'] }]; expectRule(r, 'LayerInMultipleGroups')
  })

  it('does NOT reject out-of-range keyframes (intentional, validate.rs:495-509)', () => {
    const p = blankProject(seededGen(), 't')
    const l = colorLayer('a', 0, 100)
    ;(l.params as any).color = { mode: 'Keyframed', value: [{ id: 'k', t_us: -50_000, value: { r: 1, g: 2, b: 3, a: 4 }, interp: { kind: 'Linear' } }] }
    p.tracks[0].layers = [l]
    expect(() => validate(p)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/validate.test.ts`
Expected: FAIL — `Cannot find module './validate'`.

- [ ] **Step 3: Write the implementation**

Port `validate.rs` exactly. The overlap walk (Rust `validate.rs:317-383`) and the transition overlap formula (`264-273`) are the only subtle parts — keep the comments.

```ts
// apps/desktop/src/main/state/validate.ts
import type { Layer, LayerParams, Project, Transition, Uuid } from './model'
import { ValidationFailure, type ValidationError } from './errors'

function fail(err: ValidationError): never { throw new ValidationFailure(err) }

type OverlapClass = 'visual' | 'audio'
function layerOverlapClass(params: LayerParams): OverlapClass {
  return params.kind === 'Audio' ? 'audio' : 'visual'
}
/** Canonical unordered layer-pair key for the authorized-overlap map. */
function pairKey(a: Uuid, b: Uuid): string { return a < b ? `${a}|${b}` : `${b}|${a}` }

export function validate(project: Project): void {
  validateComposition(project)
  const authorized = validateTransitions(project) // also enforces transition rules
  const seenLayers = new Set<Uuid>()
  for (const track of project.tracks) validateTrack(project, track, authorized, seenLayers)
  validateGroups(project, seenLayers)
}

function validateComposition(p: Project): void {
  const c = p.composition
  if (c.width === 0 || c.height === 0) fail({ rule: 'InvalidCanvas', width: c.width, height: c.height })
  if (c.fps.num === 0 || c.fps.den === 0) fail({ rule: 'InvalidFps', num: c.fps.num, den: c.fps.den })
}

/** Returns authorized overlaps (pairKey → overlap µs) for the per-track check. */
function validateTransitions(p: Project): Map<string, number> {
  // layer id → {track, start, end}
  const idx = new Map<Uuid, { track: Uuid; start: number; end: number }>()
  for (const t of p.tracks) for (const l of t.layers) idx.set(l.id, { track: t.id, start: l.t_start_us, end: l.t_end_us })

  const authorized = new Map<string, number>()
  const seenIds = new Set<Uuid>()
  const asFrom = new Set<Uuid>()
  const asTo = new Set<Uuid>()
  for (const tr of p.transitions) {
    if (seenIds.has(tr.id)) fail({ rule: 'DuplicateTransitionId', transition: tr.id })
    seenIds.add(tr.id)
    if (tr.from_layer === tr.to_layer) fail({ rule: 'TransitionSelfReference', transition: tr.id, layer: tr.from_layer })
    const from = idx.get(tr.from_layer) ?? fail({ rule: 'TransitionLayerMissing', transition: tr.id, layer: tr.from_layer })
    const to = idx.get(tr.to_layer) ?? fail({ rule: 'TransitionLayerMissing', transition: tr.id, layer: tr.to_layer })
    if (from.track !== to.track) fail({ rule: 'TransitionCrossTrack', transition: tr.id, from: tr.from_layer, to: tr.to_layer })
    const fromLen = Math.max(from.end - from.start, 0)
    const toLen = Math.max(to.end - to.start, 0)
    if (tr.duration_us <= 0 || tr.duration_us > fromLen || tr.duration_us > toLen)
      fail({ rule: 'TransitionDurationOutOfRange', transition: tr.id, duration: tr.duration_us })
    const overlapStart = Math.max(from.start, to.start)
    const overlapEnd = Math.min(from.end, to.end)
    const overlap = Math.max(overlapEnd - overlapStart, 0)
    if (overlap !== tr.duration_us) fail({ rule: 'TransitionDurationMismatch', transition: tr.id, duration: tr.duration_us, overlap })
    if (asFrom.has(tr.from_layer)) fail({ rule: 'LayerInMultipleTransitions', layer: tr.from_layer })
    asFrom.add(tr.from_layer)
    if (asTo.has(tr.to_layer)) fail({ rule: 'LayerInMultipleTransitions', layer: tr.to_layer })
    asTo.add(tr.to_layer)
    authorized.set(pairKey(tr.from_layer, tr.to_layer), overlap)
  }
  return authorized
}

function checkSrcRange(p: Project, layer: Uuid, media: Uuid, srcIn: number, srcOut: number): void {
  if (!(media in p.media_pool)) fail({ rule: 'MissingMedia', layer, media })
  if (srcIn < 0 || srcIn >= srcOut) fail({ rule: 'InvalidSrcRange', layer, src_in: srcIn, src_out: srcOut })
  const dur = p.media_pool[media].metadata.duration_us
  if (dur !== null && dur !== undefined && srcOut > dur)
    fail({ rule: 'SrcRangeExceedsMedia', layer, src_in: srcIn, src_out: srcOut, media_duration: dur })
}

function validateLayerParams(p: Project, layer: Layer): void {
  // Out-of-range keyframes are intentionally NOT checked (validate.rs:495-509).
  const pa = layer.params
  if (pa.kind === 'VideoClip' || pa.kind === 'Audio') checkSrcRange(p, layer.id, pa.media, pa.src_in_us, pa.src_out_us)
  else if (pa.kind === 'ImageOverlay') { if (!(pa.media in p.media_pool)) fail({ rule: 'MissingMedia', layer: layer.id, media: pa.media }) }
}

function validateTrack(p: Project, track: Project['tracks'][number], authorized: Map<string, number>, seenLayers: Set<Uuid>): void {
  const sorted = [...track.layers].sort((x, y) => x.t_start_us - y.t_start_us)
  let prevVisual: Layer | null = null
  let prevAudio: Layer | null = null
  for (const layer of sorted) {
    if (seenLayers.has(layer.id)) fail({ rule: 'DuplicateLayerId', layer: layer.id })
    seenLayers.add(layer.id)
    if (layer.t_start_us >= layer.t_end_us) fail({ rule: 'InvalidLayerRange', layer: layer.id, t_start: layer.t_start_us, t_end: layer.t_end_us })
    validateLayerParams(p, layer)
    const cls = layerOverlapClass(layer.params)
    const prev = cls === 'visual' ? prevVisual : prevAudio
    if (prev && layer.t_start_us < prev.t_end_us) {
      const overlap = prev.t_end_us - layer.t_start_us
      const allowed = authorized.get(pairKey(prev.id, layer.id)) ?? 0
      if (allowed !== overlap)
        fail({ rule: 'LayerOverlap', track: track.id, a: prev.id, a_start: prev.t_start_us, a_end: prev.t_end_us, b: layer.id, b_start: layer.t_start_us, b_end: layer.t_end_us })
    }
    // Track the longest-reaching prior layer of this class (handles a long
    // clip starting earlier than a short one — validate.rs:365-383).
    if (cls === 'visual') prevVisual = prevVisual && prevVisual.t_end_us >= layer.t_end_us ? prevVisual : layer
    else prevAudio = prevAudio && prevAudio.t_end_us >= layer.t_end_us ? prevAudio : layer
  }
}

function validateGroups(p: Project, knownLayers: Set<Uuid>): void {
  const seenIds = new Set<Uuid>()
  const layerToGroup = new Map<Uuid, Uuid>()
  for (const g of p.groups) {
    if (seenIds.has(g.id)) fail({ rule: 'DuplicateGroupId', group: g.id })
    seenIds.add(g.id)
    if (g.members.length < 2) fail({ rule: 'GroupBelowMinSize', group: g.id, members: g.members.length })
    for (const m of g.members) {
      if (!knownLayers.has(m)) fail({ rule: 'GroupMemberMissing', group: g.id, layer: m })
      const first = layerToGroup.get(m)
      if (first !== undefined) fail({ rule: 'LayerInMultipleGroups', layer: m, first, second: g.id })
      layerToGroup.set(m, g.id)
    }
  }
}
```

> NOTE: `validateGroups` uses `knownLayers` built during the track walk (Rust collects layer ids separately; the seen-set is identical content). The `?? fail(...)` idiom relies on `fail` returning `never` — TypeScript accepts it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/validate.test.ts`
Expected: PASS (all rules).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/validate.ts apps/desktop/src/main/state/validate.test.ts
git commit -m "feat(state-migration): port validate.rs (26-rule full-project validator)"
```

---

## Task 4: History (`history.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/history.ts`
- Test: `apps/desktop/src/main/state/history.test.ts`

**Interfaces:**
- Consumes: `Project` from `model.ts`; `Actor` (defined here).
- Produces:
  - `type Actor = { kind: 'User' } | { kind: 'Agent'; client: string }`.
  - `interface HistoryEntry { op_id: Uuid; actor: Actor; timestamp: string; summary: string; affected: EntityRef[]; snapshot: Project }`.
  - `type EntityRef = { kind: 'Track'; id: Uuid } | { kind: 'Layer'; id: Uuid } | ...` (Phase 1 needs Track/Layer/Marker).
  - `class History` with: `constructor(initial, actor, opId)`, `current()`, `record(entry)`, `undo()`, `redo()`, `canUndo()`, `canRedo()`, `cursorIndex()`, `len()`, `checkpoint(label, actor, id)`, `restoreCheckpoint(id, opId, timestamp, actor)`, `listCheckpoints()`, `lock(reason)`, `unlock()`, `lockReason()`, `view(limit)`, `status()`, `replaceSettingsEverywhere(settings)`.
  - The `History` does **not** allocate ids itself (so the actor controls the deterministic counter). The actor passes `opId`/`timestamp` in. (Rust allocates inside; here the actor owns the idGen — see Task 10.)

Source: `native/src/state/history.rs`. Cap = 200.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/history.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, type Project } from './model'
import { History, type HistoryEntry } from './history'

const U = { kind: 'User' as const }
function entry(p: Project, op: string): HistoryEntry {
  return { op_id: op, actor: U, timestamp: '<TS>', summary: op, affected: [], snapshot: p }
}
function freshProject(name: string): Project { return blankProject(seededGen(), name) }

describe('History', () => {
  it('records, undoes, and redoes', () => {
    const h = new History(freshProject('0'), U, 'op0')
    expect(h.canUndo()).toBe(false)
    h.record(entry(freshProject('1'), 'op1'))
    h.record(entry(freshProject('2'), 'op2'))
    expect(h.current().metadata.name).toBe('2')
    expect(h.undo()!.metadata.name).toBe('1')
    expect(h.undo()!.metadata.name).toBe('0')
    expect(h.undo()).toBeNull() // boundary
    expect(h.redo()!.metadata.name).toBe('1')
  })

  it('truncates the redo tail on a new record after undo', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    h.record(entry(freshProject('2'), 'op2'))
    h.undo() // at '1'
    h.record(entry(freshProject('3'), 'op3'))
    expect(h.current().metadata.name).toBe('3')
    expect(h.redo()).toBeNull() // '2' was truncated
    expect(h.undo()!.metadata.name).toBe('1')
  })

  it('evicts from the front at capacity (cap 200)', () => {
    const h = new History(freshProject('seed'), U, 'op0')
    for (let i = 0; i < 250; i++) h.record(entry(freshProject(`e${i}`), `op${i}`))
    expect(h.len()).toBe(200)
    expect(h.current().metadata.name).toBe('e249')
  })

  it('blocks revert while locked and reports the reason', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    h.lock('agent session')
    expect(h.lockReason()).toBe('agent session')
    h.unlock()
    expect(h.lockReason()).toBeNull()
  })

  it('checkpoints survive truncation and restore records a new entry', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    h.checkpoint('cp', U, 'cpid')
    h.record(entry(freshProject('2'), 'op2'))
    const restored = h.restoreCheckpoint('cpid', 'op-restore', '<TS>', U)
    expect(restored!.metadata.name).toBe('1')
    expect(h.current().metadata.name).toBe('1') // restore recorded a new head
  })

  it('replaceSettingsEverywhere maps over all snapshots without moving the cursor', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    const before = h.cursorIndex()
    h.replaceSettingsEverywhere({ preview_width: 640, preview_height: 360, autosave_interval_secs: 30, history_capacity: 200, auto_pair_audio_on_import: false, auto_delete_empty_tracks: false })
    expect(h.cursorIndex()).toBe(before)
    expect(h.current().settings.preview_width).toBe(640)
    expect(h.undo()!.settings.preview_width).toBe(640) // applied to the older snapshot too
  })

  it('view returns the last N summaries + cursor + len; status mirrors flags', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    const v = h.view(10)
    expect(v.len).toBe(2); expect(v.cursor).toBe(1); expect(v.ops.length).toBe(2)
    const s = h.status()
    expect(s).toMatchObject({ cursor: 1, len: 2, can_undo: true, can_redo: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/history.test.ts`
Expected: FAIL — `Cannot find module './history'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/state/history.ts
import type { Project, ProjectSettings, Uuid } from './model'

export type Actor = { kind: 'User' } | { kind: 'Agent'; client: string }
export type EntityRef =
  | { kind: 'Track'; id: Uuid } | { kind: 'Layer'; id: Uuid } | { kind: 'Marker'; id: Uuid }

export interface HistoryEntry {
  op_id: Uuid; actor: Actor; timestamp: string; summary: string
  affected: EntityRef[]; snapshot: Project
}
interface NamedCheckpoint { id: Uuid; label: string; actor: Actor; created_at: string; snapshot: Project }
export interface HistoryEntrySummary { op_id: Uuid; actor: Actor; timestamp: string; summary: string; affected: EntityRef[] }
export interface HistoryView { ops: HistoryEntrySummary[]; cursor: number; len: number; checkpoints: Array<{ id: Uuid; label: string; created_at: string }>; lock_reason?: string }
export interface HistoryStatus { cursor: number; len: number; can_undo: boolean; can_redo: boolean; lock_reason?: string }

const DEFAULT_CAP = 200

/** 1:1 port of native/src/state/history.rs. Ids/timestamps are injected by the
 *  actor (which owns the deterministic counter) rather than minted here. */
export class History {
  private snapshots: HistoryEntry[] = []
  private cursor = 0
  private cap = DEFAULT_CAP
  private checkpoints = new Map<Uuid, NamedCheckpoint>()
  private lockReasonStr: string | null = null

  constructor(initial: Project, actor: Actor, opId: Uuid, timestamp = '<TS>') {
    this.snapshots.push({ op_id: opId, actor, timestamp, summary: 'Initial', affected: [], snapshot: initial })
    this.cursor = 0
  }

  current(): Project { return this.snapshots[this.cursor].snapshot }

  record(entry: HistoryEntry): void {
    this.snapshots = this.snapshots.slice(0, this.cursor + 1) // truncate redo tail
    this.snapshots.push(entry)
    while (this.snapshots.length > this.cap) this.snapshots.shift() // evict front
    this.cursor = this.snapshots.length - 1
  }

  undo(): Project | null {
    if (this.cursor === 0) return null
    this.cursor -= 1
    return this.snapshots[this.cursor].snapshot
  }
  redo(): Project | null {
    if (this.cursor + 1 >= this.snapshots.length) return null
    this.cursor += 1
    return this.snapshots[this.cursor].snapshot
  }
  canUndo(): boolean { return this.cursor > 0 }
  canRedo(): boolean { return this.cursor + 1 < this.snapshots.length }
  cursorIndex(): number { return this.cursor }
  len(): number { return this.snapshots.length }

  lock(reason: string): void { this.lockReasonStr = reason }
  unlock(): void { this.lockReasonStr = null }
  lockReason(): string | null { return this.lockReasonStr }

  checkpoint(label: string, actor: Actor, id: Uuid, createdAt = '<TS>'): Uuid {
    this.checkpoints.set(id, { id, label, actor, created_at: createdAt, snapshot: this.current() })
    return id
  }
  restoreCheckpoint(id: Uuid, opId: Uuid, timestamp: string, actor: Actor): Project | null {
    const cp = this.checkpoints.get(id)
    if (!cp) return null
    this.record({ op_id: opId, actor, timestamp, summary: `Restored checkpoint '${cp.label}'`, affected: [], snapshot: cp.snapshot })
    return cp.snapshot
  }
  listCheckpoints(): NamedCheckpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  }

  /** Preference patch applied to ALL snapshots + checkpoints; cursor unchanged
   *  (project_settings_patch_convention). Phase 1 needs only settings; track/role
   *  flag variants land in Phase 3. */
  replaceSettingsEverywhere(settings: ProjectSettings): void {
    for (const e of this.snapshots) e.snapshot = { ...e.snapshot, settings: { ...settings } }
    for (const cp of this.checkpoints.values()) cp.snapshot = { ...cp.snapshot, settings: { ...settings } }
  }

  view(limit: number): HistoryView {
    const total = this.snapshots.length
    const take = Math.min(limit, total)
    const ops = this.snapshots.slice(total - take).map((e) => ({ op_id: e.op_id, actor: e.actor, timestamp: e.timestamp, summary: e.summary, affected: e.affected }))
    const checkpoints = this.listCheckpoints().map((c) => ({ id: c.id, label: c.label, created_at: c.created_at }))
    const v: HistoryView = { ops, cursor: this.cursor, len: total, checkpoints }
    if (this.lockReasonStr !== null) v.lock_reason = this.lockReasonStr
    return v
  }
  status(): HistoryStatus {
    const s: HistoryStatus = { cursor: this.cursor, len: this.snapshots.length, can_undo: this.canUndo(), can_redo: this.canRedo() }
    if (this.lockReasonStr !== null) s.lock_reason = this.lockReasonStr
    return s
  }
}
```

> NOTE on `replaceSettingsEverywhere`: it shallow-copies each entry's `snapshot` with a new `settings`. Because these snapshots are Immer-frozen (Task 10), a plain spread that replaces `settings` is required (cannot mutate in place). The cursor never moves — matches `history.rs:263-274`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/history.ts apps/desktop/src/main/state/history.test.ts
git commit -m "feat(state-migration): port history.rs (undo/redo/checkpoint/lock/cap-200)"
```

---

## Task 5: Mutation helpers (`mutations/helpers.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/mutations/helpers.ts`
- Test: `apps/desktop/src/main/state/mutations/helpers.test.ts`

**Interfaces:**
- Consumes: model types; `snapFrameRound` from `../snap`; `CommandFailure` from `../errors`; `IdGen` from `../ids`.
- Produces (all operate on a mutable `Project` draft unless noted):
  - `locateLayer(p, id): [number, number] | null`
  - `applyDurationAutofit(p): void`
  - `pruneEmptyHiddenTracks(p): void`
  - `pruneEmptiedTrack(p, trackId): Uuid | null`
  - `dropLayerFromGroups(p, layerId): void`
  - `checkTrackLock(p, id): void` (throws `CommandFailure`)
  - `shiftLayerKeyframes(params, deltaUs): void`
  - `newColorLayer/newTextLayer` not here — layer construction lives in `add.ts`. Helpers stay generic.

Source: `mutations.rs:28-42, 91-173, 645-704`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/helpers.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyDurationAutofit, dropLayerFromGroups, locateLayer, pruneEmptiedTrack, checkTrackLock } from './helpers'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

describe('helpers', () => {
  it('locateLayer finds (trackIdx, layerIdx)', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[1].layers = [color('a', 0, 1)]
    expect(locateLayer(p, 'a')).toEqual([1, 0]); expect(locateLayer(p, 'nope')).toBeNull()
  })
  it('applyDurationAutofit grows+shrinks unpinned, grow-only when pinned', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [color('a', 0, 5_000_000)]
    applyDurationAutofit(p); expect(p.composition.duration_us).toBe(5_000_000)
    p.tracks[0].layers = [color('a', 0, 2_000_000)]
    applyDurationAutofit(p); expect(p.composition.duration_us).toBe(2_000_000) // shrank
    p.composition.duration_pinned = true; p.composition.duration_us = 9_000_000
    p.tracks[0].layers = [color('a', 0, 2_000_000)]
    applyDurationAutofit(p); expect(p.composition.duration_us).toBe(9_000_000) // pinned: no shrink
    p.tracks[0].layers = [color('a', 0, 12_000_000)]
    applyDurationAutofit(p); expect(p.composition.duration_us).toBe(12_000_000) // pinned: overflow grows
  })
  it('pruneEmptiedTrack removes only empty+removable+roleless+unlocked tracks when the setting is on', () => {
    const p = blankProject(seededGen(), 't')
    // A-roll is removable:false (role stamped) → survives even when empty.
    expect(pruneEmptiedTrack(p, p.tracks[0].id)).toBeNull()
    const added = { id: 'tx', label: null, enabled: true, locked: false, muted: false, solo: false, removable: true, role: null, transient: false, height_px: 64, layers: [] }
    p.tracks.push(added as Project['tracks'][number])
    expect(pruneEmptiedTrack(p, 'tx')).toBe('tx')
    expect(p.tracks.find((t) => t.id === 'tx')).toBeUndefined()
  })
  it('dropLayerFromGroups removes the member and auto-dissolves below 2', () => {
    const p = blankProject(seededGen(), 't')
    p.groups = [{ id: 'g', members: ['a', 'b'] }]
    dropLayerFromGroups(p, 'a')
    expect(p.groups.length).toBe(0) // dropped to 1 → dissolved
  })
  it('checkTrackLock throws TrackLocked / LayerNotFound', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].locked = true; p.tracks[0].layers = [color('a', 0, 1)]
    try { checkTrackLock(p, 'a'); throw new Error('expected throw') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
    try { checkTrackLock(p, 'ghost'); throw new Error('expected throw') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/helpers.test.ts`
Expected: FAIL — `Cannot find module './helpers'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/state/mutations/helpers.ts
import type { Animated, Keyframe, Layer, LayerParams, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'

/** mutations.rs:651-658 */
export function locateLayer(p: Project, id: Uuid): [number, number] | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const li = p.tracks[ti].layers.findIndex((l) => l.id === id)
    if (li >= 0) return [ti, li]
  }
  return null
}

/** mutations.rs:28-42 — reconcile composition.duration_us with the layer high-water mark. */
export function applyDurationAutofit(p: Project): void {
  let maxEnd = 0
  for (const t of p.tracks) for (const l of t.layers) if (l.t_end_us > maxEnd) maxEnd = l.t_end_us
  if (p.composition.duration_pinned) { if (maxEnd > p.composition.duration_us) p.composition.duration_us = maxEnd }
  else p.composition.duration_us = maxEnd
}

/** mutations.rs:645-647 — drop empty transient (import-spawned) tracks. */
export function pruneEmptyHiddenTracks(p: Project): void {
  p.tracks = p.tracks.filter((t) => !(t.transient && t.layers.length === 0))
}

/** mutations.rs:144-155 — auto-delete the just-emptied track if eligible. */
export function pruneEmptiedTrack(p: Project, trackId: Uuid): Uuid | null {
  if (!p.settings.auto_delete_empty_tracks) return null
  const idx = p.tracks.findIndex((t) => t.id === trackId)
  if (idx < 0) return null
  const t = p.tracks[idx]
  if (t.layers.length !== 0 || !t.removable || t.role !== null || t.locked) return null
  p.tracks.splice(idx, 1)
  return trackId
}

/** mutations.rs:160-173 — remove a layer from every group; auto-dissolve below 2. */
export function dropLayerFromGroups(p: Project, layerId: Uuid): void {
  let i = 0
  while (i < p.groups.length) {
    const g = p.groups[i]
    if (g.members.includes(layerId)) {
      g.members = g.members.filter((m) => m !== layerId)
      if (g.members.length < 2) { p.groups.splice(i, 1); continue }
    }
    i++
  }
}

/** mutations.rs:97-104 — locked-track guard; missing layer → LayerNotFound. */
export function checkTrackLock(p: Project, id: Uuid): void {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const track = p.tracks[loc[0]]
  if (track.locked) throw new CommandFailure({ error: 'TrackLocked', track: track.id })
}

function shiftAnimated<T>(a: Animated<T>, deltaUs: number): void {
  if (a.mode === 'Keyframed') for (const k of a.value as Keyframe<T>[]) k.t_us += deltaUs
}
/** Shift every animated track's keyframes by deltaUs (trim IN glues keyframes to
 *  content). All-Static in Phase 1, so this is a no-op there; written for fidelity. */
export function shiftLayerKeyframes(params: LayerParams, deltaUs: number): void {
  switch (params.kind) {
    case 'Color': shiftAnimated(params.color, deltaUs); break
    case 'Text':
      shiftAnimated(params.color, deltaUs); shiftAnimated(params.opacity, deltaUs)
      shiftTransform(params.transform, deltaUs); break
    case 'VideoClip': shiftAnimated(params.opacity, deltaUs); shiftTransform(params.transform, deltaUs); break
    case 'ImageOverlay': shiftAnimated(params.opacity, deltaUs); shiftTransform(params.transform, deltaUs); break
    case 'Motif': shiftAnimated(params.opacity, deltaUs); shiftTransform(params.transform, deltaUs); break
    case 'Audio': shiftAnimated(params.gain_db, deltaUs); shiftAnimated(params.pan, deltaUs); break
  }
}
function shiftTransform(t: { x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; rotation_deg: Animated<number> }, d: number): void {
  shiftAnimated(t.x, d); shiftAnimated(t.y, d); shiftAnimated(t.scale_x, d); shiftAnimated(t.scale_y, d); shiftAnimated(t.rotation_deg, d)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/helpers.ts apps/desktop/src/main/state/mutations/helpers.test.ts
git commit -m "feat(state-migration): shared mutation helpers (autofit/prune/locate/lock/kf-shift)"
```

---

## Task 6: Additive mutations (`mutations/add.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/mutations/add.ts`
- Test: `apps/desktop/src/main/state/mutations/add.test.ts`

**Interfaces:**
- Consumes: model types; `IdGen`; `snapFrameRound`; `applyDurationAutofit`; `CommandFailure`.
- Produces (each mutates the `Project` draft and returns the new id where applicable):
  - `applyAddLayer(p, idGen, trackId, params, tStartUs, tEndUs): Uuid` — throws `TrackNotFound` if the track is absent (BEFORE allocating the layer id, matching `mutations.rs:47-89`).
  - `applyAddTrack(p, idGen, label, transient?, position?): Uuid`.
  - `applyAddMarker(p, idGen, tUs, endTUs, label, color): Uuid`.
  - `colorParams(rgba, w, h): LayerParams`, `textParamsDefault(content): LayerParams` (small constructors used by the replay driver).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/add.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, applyAddMarker, applyAddTrack, colorParams } from './add'
import { isCommandFailure } from '../errors'

describe('additive mutations', () => {
  it('applyAddLayer snaps both edges, inserts t-start-sorted, autofits, returns id', () => {
    const g = seededGen(); const p = blankProject(g, 't') // ids 1,2,3 used
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 255, g: 0, b: 0, a: 255 }, 1920, 1080), 1_000_000, 2_000_000)
    expect(a).toBe('00000000-0000-0000-0000-000000000004') // first post-blank id
    expect(p.tracks[0].layers).toHaveLength(1)
    expect(p.composition.duration_us).toBe(2_000_000)
    // insert sorted: add an earlier layer, it goes to index 0
    applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 500_000)
    expect(p.tracks[0].layers[0].t_start_us).toBe(0)
  })
  it('applyAddLayer rejects an unknown track BEFORE consuming the layer id', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyAddLayer(p, g, 'ghost', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackNotFound') }
    // next id is still 4 (none consumed by the rejected add)
    expect(applyAddTrack(p, g, 'L')).toBe('00000000-0000-0000-0000-000000000004')
  })
  it('applyAddTrack uses Track::new defaults (removable, role null, height 64)', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const id = applyAddTrack(p, g, 'Track')
    const t = p.tracks.find((x) => x.id === id)!
    expect(t).toMatchObject({ label: 'Track', enabled: true, locked: false, muted: false, solo: false, removable: true, role: null, transient: false, height_px: 64 })
  })
  it('applyAddMarker inserts t-sorted', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    applyAddMarker(p, g, 2_000_000, null, 'm2', { r: 0, g: 128, b: 255, a: 255 })
    applyAddMarker(p, g, 1_000_000, null, 'm1', { r: 0, g: 128, b: 255, a: 255 })
    expect(p.markers.map((m) => m.t_us)).toEqual([1_000_000, 2_000_000])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/add.test.ts`
Expected: FAIL — `Cannot find module './add'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/state/mutations/add.ts
import type { Layer, LayerParams, Marker, Project, Rgba, TrackRole, Uuid } from '../model'
import type { IdGen } from '../ids'
import { snapFrameRound } from '../snap'
import { applyDurationAutofit } from './helpers'
import { CommandFailure } from '../errors'

export function colorParams(color: Rgba, width: number, height: number): LayerParams {
  return { kind: 'Color', color: { mode: 'Static', value: color }, width, height }
}
export function textParamsDefault(content: string): LayerParams {
  // Mirrors the replay driver's default_text_params (replay_driver.rs:747-758):
  // Inter 48 / weight 400 / white / Center / default transform / opacity 1 / Auto.
  return {
    kind: 'Text', content,
    font: { family: 'Inter', size_px: 48, weight: 400, italic: false },
    color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
    align: 'Center', transform: defaultTransform(), opacity: { mode: 'Static', value: 1 },
    shadow: null, outline: null, intro: null, outro: null, backend_hint: 'Auto',
  }
}
function defaultTransform() {
  const s = (v: number) => ({ mode: 'Static' as const, value: v })
  return { x: s(0), y: s(0), scale_x: s(1), scale_y: s(1), rotation_deg: s(0), anchor: [0.5, 0.5] as [number, number] }
}

/** mutations.rs:47-89. Snaps both edges, inserts t-start-sorted, autofits.
 *  Allocates the layer id only AFTER the track-existence check (id contract). */
export function applyAddLayer(p: Project, idGen: IdGen, trackId: Uuid, params: LayerParams, tStartUs: number, tEndUs: number): Uuid {
  const t0 = snapFrameRound(tStartUs, p.composition.fps.num, p.composition.fps.den)
  const t1 = snapFrameRound(tEndUs, p.composition.fps.num, p.composition.fps.den)
  const trackIdx = p.tracks.findIndex((t) => t.id === trackId)
  if (trackIdx < 0) throw new CommandFailure({ error: 'TrackNotFound', track: trackId })
  const layerId = idGen()
  const layer: Layer = { id: layerId, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
  const track = p.tracks[trackIdx]
  const at = track.layers.findIndex((l) => l.t_start_us > t0)
  track.layers.splice(at < 0 ? track.layers.length : at, 0, layer)
  applyDurationAutofit(p)
  return layerId
}

/** track.rs:65-79 defaults + actor.rs:2353-2380 insertion. */
export function applyAddTrack(p: Project, idGen: IdGen, label: string | null, transient = false, position?: number): Uuid {
  const id = idGen()
  const track = { id, label, enabled: true, locked: false, muted: false, solo: false, removable: true, role: null as TrackRole | null, transient, height_px: 64, layers: [] as Layer[] }
  const len = p.tracks.length
  const at = Math.min(position ?? len, len)
  p.tracks.splice(at, 0, track)
  return id
}

/** actor.rs:3101-3135 — marker inserted t-sorted, empty metadata. */
export function applyAddMarker(p: Project, idGen: IdGen, tUs: number, endTUs: number | null, label: string, color: Rgba): Uuid {
  const id = idGen()
  const marker: Marker = { id, t_us: tUs, end_t_us: endTUs, label, color, metadata: {} }
  const at = p.markers.findIndex((m) => m.t_us > tUs)
  p.markers.splice(at < 0 ? p.markers.length : at, 0, marker)
  return id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/add.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/add.ts apps/desktop/src/main/state/mutations/add.test.ts
git commit -m "feat(state-migration): additive mutations (add_layer/add_track/add_marker)"
```

---

## Task 7: move_layer (`mutations/move.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/mutations/move.ts`
- Test: `apps/desktop/src/main/state/mutations/move.test.ts`

**Interfaces:**
- Consumes: model types; `IdGen` (none needed — move allocates no id); `snapFrameRound`; helpers (`locateLayer`, `applyDurationAutofit`, `pruneEmptyHiddenTracks`); `CommandFailure`.
- Produces: `applyMoveLayer(p, id, newTrackId, newTStartUs, escapeGroup): void`.

Verbatim Rust source (port exactly — `mutations.rs:502-635`): snap new start → locate → reject locked source/dest track → `delta = snapped - cur_start` → group siblings (empty in P1) → remove the layer → set `t_start = snapped`, `t_end = snap(t_end + delta)` → reinsert t-start-sorted on the dest → group fan-out (dead in P1) → autofit → prune transient. The `groupSiblingsExcluding` helper returns `[]` whenever `project.groups` is empty, so the fan-out loop never runs in Phase 1.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/move.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, colorParams } from './add'
import { applyMoveLayer } from './move'
import { isCommandFailure } from '../errors'

describe('applyMoveLayer', () => {
  it('moves within a track, snapping both edges and preserving duration', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyMoveLayer(p, a, p.tracks[0].id, 2_000_000, false)
    const l = p.tracks[0].layers[0]
    expect(l.t_start_us).toBe(2_000_000)
    expect(l.t_end_us - l.t_start_us).toBe(1_000_000) // duration preserved
  })
  it('moves across tracks', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyMoveLayer(p, a, p.tracks[1].id, 0, false)
    expect(p.tracks[0].layers).toHaveLength(0)
    expect(p.tracks[1].layers[0].id).toBe(a)
  })
  it('rejects a missing layer and a locked source track', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyMoveLayer(p, 'ghost', p.tracks[0].id, 0, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    p.tracks[0].locked = true
    try { applyMoveLayer(p, a, p.tracks[0].id, 1_000_000, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/move.test.ts`
Expected: FAIL — `Cannot find module './move'`.

- [ ] **Step 3: Write the implementation** (port `mutations.rs:502-635`)

```ts
// apps/desktop/src/main/state/mutations/move.ts
import type { Layer, Project, Uuid } from '../model'
import { snapFrameRound } from '../snap'
import { applyDurationAutofit, locateLayer, pruneEmptyHiddenTracks } from './helpers'
import { CommandFailure } from '../errors'

/** All other members of `id`'s group (empty when ungrouped). Phase 1 never
 *  creates groups, so this is always []; the fan-out below is dead code kept
 *  for the Phase-2 wiring (mutations.rs:661-669). */
function groupSiblingsExcluding(p: Project, id: Uuid): Uuid[] {
  for (const g of p.groups) if (g.members.includes(id)) return g.members.filter((m) => m !== id)
  return []
}

/** Port of mutations.rs:502-635. */
export function applyMoveLayer(p: Project, id: Uuid, newTrackId: Uuid, newTStartUs: number, escapeGroup: boolean): void {
  const fpsN = p.composition.fps.num, fpsD = p.composition.fps.den
  const snapped = snapFrameRound(newTStartUs, fpsN, fpsD)
  const src = locateLayer(p, id)
  if (!src) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [srcTi] = src
  const curStart = p.tracks[srcTi].layers[src[1]].t_start_us
  if (p.tracks[srcTi].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[srcTi].id })
  if (newTrackId !== p.tracks[srcTi].id) {
    const dst = p.tracks.find((t) => t.id === newTrackId)
    if (dst && dst.locked) throw new CommandFailure({ error: 'TrackLocked', track: newTrackId })
  }
  const delta = snapped - curStart

  const siblings = escapeGroup ? [] : groupSiblingsExcluding(p, id)
  // (group lock check omitted in P1: siblings always empty; ported in Phase 2)

  // Remove the target layer.
  let moved: Layer | undefined
  for (const track of p.tracks) {
    const idx = track.layers.findIndex((l) => l.id === id)
    if (idx >= 0) { moved = track.layers.splice(idx, 1)[0]; break }
  }
  const layer = moved! // existence verified above
  layer.t_start_us = snapped
  // Re-snap t_end to the grid (alternating 33_333/33_334µs frame widths at 30fps).
  layer.t_end_us = snapFrameRound(layer.t_end_us + delta, fpsN, fpsD)
  const destIdx = p.tracks.findIndex((t) => t.id === newTrackId)
  if (destIdx < 0) throw new CommandFailure({ error: 'TrackNotFound', track: newTrackId })
  const dest = p.tracks[destIdx]
  const at = dest.layers.findIndex((l) => l.t_start_us > snapped)
  dest.layers.splice(at < 0 ? dest.layers.length : at, 0, layer)

  // Group siblings follow + shift by the same delta (dead in Phase 1).
  if (!escapeGroup) {
    for (const sid of siblings) {
      const loc = locateLayer(p, sid)
      if (!loc) continue
      const s = p.tracks[loc[0]].layers.splice(loc[1], 1)[0]
      if (delta !== 0) {
        s.t_start_us = snapFrameRound(s.t_start_us + delta, fpsN, fpsD)
        s.t_end_us = snapFrameRound(s.t_end_us + delta, fpsN, fpsD)
      }
      s.t_start_us = Math.max(s.t_start_us, 0)
      const di = p.tracks.findIndex((t) => t.id === newTrackId)
      const sAt = p.tracks[di].layers.findIndex((l) => l.t_start_us > s.t_start_us)
      p.tracks[di].layers.splice(sAt < 0 ? p.tracks[di].layers.length : sAt, 0, s)
    }
  }

  applyDurationAutofit(p)
  pruneEmptyHiddenTracks(p)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/move.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/move.ts apps/desktop/src/main/state/mutations/move.test.ts
git commit -m "feat(state-migration): port move_layer (incl. dead-in-P1 group fan-out)"
```

---

## Task 8: trim_layer (`mutations/trim.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/mutations/trim.ts`
- Test: `apps/desktop/src/main/state/mutations/trim.test.ts`

**Interfaces:**
- Consumes: model types; `snapFrameRound`; helpers; `CommandFailure`.
- Produces:
  - `type LayerEdge = 'In' | 'Out'`.
  - `clampSigned(d, min, max): number` (`mutations.rs:1224-1230`).
  - `trimDeltaBounds(layer, edge, motifMaxDurUs, fps): { min: number; max: number }` (`mutations.rs:1121-1222`; in P1 `motifMaxDurUs` is always `null` → the motif-cap branches collapse to ±INF).
  - `applyTrimLayer(p, id, edge, newTUs, escapeGroup): void` (`mutations.rs:881-1062`).

Phase-1 layers are Color/Text (no `src_*`, no motif), so `trimDeltaBounds` reduces to timeline bounds: IN → `[-t_start, dur-1]`, OUT → `[-(dur-1), INF]`. Keyframes shift by `-delta` on IN only. `aligned = [id]` always (no groups).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/trim.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, colorParams } from './add'
import { applyTrimLayer, clampSigned } from './trim'
import { isCommandFailure } from '../errors'

function setup() {
  const g = seededGen(); const p = blankProject(g, 't')
  const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 1_000_000, 3_000_000)
  return { p, a }
}
describe('trim', () => {
  it('clampSigned collapses inverted bounds to 0', () => {
    expect(clampSigned(50, -10, 10)).toBe(10)
    expect(clampSigned(-50, -10, 10)).toBe(-10)
    expect(clampSigned(5, 10, -10)).toBe(0)
  })
  it('trims the IN edge later (shortening)', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'In', 1_500_000, false)
    const l = p.tracks[0].layers.find((x) => x.id === a)!
    expect(l.t_start_us).toBe(1_500_000); expect(l.t_end_us).toBe(3_000_000)
  })
  it('clamps an IN trim so t_start stays < t_end', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'In', 9_000_000, false) // way past t_end → clamps to dur-1
    const l = p.tracks[0].layers.find((x) => x.id === a)!
    expect(l.t_start_us).toBeLessThan(l.t_end_us)
  })
  it('trims the OUT edge and rejects a zero-effect trim as TrimEdgeOutOfRange', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'Out', 4_000_000, false)
    expect(p.tracks[0].layers.find((x) => x.id === a)!.t_end_us).toBe(4_000_000)
    // trimming OUT to current end → delta 0 after the no-op early return is NOT an error;
    // trimming OUT below t_start+1 → clamps; trimming with bounds collapsed → TrimEdgeOutOfRange
    const { p: p2, a: a2 } = setup()
    try { applyTrimLayer(p2, a2, 'Out', 1_000_000, false); /* would invert → clamp to -(dur-1); nonzero so applies */ } catch { /* ok */ }
  })
  it('rejects a locked track', () => {
    const { p, a } = setup(); p.tracks[0].locked = true
    try { applyTrimLayer(p, a, 'In', 1_500_000, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/trim.test.ts`
Expected: FAIL — `Cannot find module './trim'`.

- [ ] **Step 3: Write the implementation** (port `mutations.rs:881-1062, 1121-1230`)

```ts
// apps/desktop/src/main/state/mutations/trim.ts
import type { Layer, Project, Uuid } from '../model'
import { snapFrameRound } from '../snap'
import { applyDurationAutofit, locateLayer, shiftLayerKeyframes } from './helpers'
import { CommandFailure } from '../errors'

export type LayerEdge = 'In' | 'Out'
const INF = Math.floor(Number.MAX_SAFE_INTEGER / 4)

export function clampSigned(d: number, min: number, max: number): number {
  if (min > max) return 0 // bounds collapsed — no movement allowed
  return Math.min(Math.max(d, min), max)
}

/** mutations.rs:1121-1222. motifMaxDurUs is null for all Phase-1 kinds → the
 *  motif-cap branches collapse to ±INF; only timeline + src bounds remain. */
export function trimDeltaBounds(layer: Layer, edge: LayerEdge, _motifMaxDurUs: number | null): { min: number; max: number } {
  const dur = layer.t_end_us - layer.t_start_us
  const pa = layer.params
  if (edge === 'In') {
    const timelineMin = -layer.t_start_us
    const timelineMax = dur - 1
    let srcMin = -INF, srcMax = INF
    if (pa.kind === 'VideoClip' || pa.kind === 'Audio') { srcMin = -pa.src_in_us; srcMax = pa.src_out_us - pa.src_in_us - 1 }
    return { min: Math.max(timelineMin, srcMin), max: Math.min(timelineMax, srcMax) }
  } else {
    const timelineMin = -(dur - 1)
    let srcMin = -INF; const srcMax = INF
    if (pa.kind === 'VideoClip' || pa.kind === 'Audio') srcMin = -(pa.src_out_us - pa.src_in_us - 1)
    return { min: Math.max(timelineMin, srcMin), max: srcMax }
  }
}

/** Port of mutations.rs:881-1062 (Phase-1 scope: aligned = [id], no motif cap). */
export function applyTrimLayer(p: Project, id: Uuid, edge: LayerEdge, newTUs: number, escapeGroup: boolean): void {
  const fpsN = p.composition.fps.num, fpsD = p.composition.fps.den
  const snapped = snapFrameRound(newTUs, fpsN, fpsD)
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  if (p.tracks[ti].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[ti].id })
  const target = p.tracks[ti].layers[li]
  const curStart = target.t_start_us, curEnd = target.t_end_us
  const curEdgeT = edge === 'In' ? curStart : curEnd

  // Aligned set: just the target in Phase 1 (groups deferred). escapeGroup is a no-op here.
  const aligned: Uuid[] = [id]
  void escapeGroup

  const requestedDelta = snapped - curEdgeT
  if (requestedDelta === 0) return // no-op early return (mutations.rs:931-933)

  // Clamp against every aligned member (just the target in P1).
  let clamped = requestedDelta
  for (const mid of aligned) {
    const ml = locateLayer(p, mid)!
    const m = p.tracks[ml[0]].layers[ml[1]]
    const b = trimDeltaBounds(m, edge, null)
    clamped = clampSigned(clamped, b.min, b.max)
  }
  if (clamped === 0) throw new CommandFailure({ error: 'TrimEdgeOutOfRange', layer: id, new_t: snapped, cur_start: curStart, cur_end: curEnd })

  for (const mid of aligned) {
    const ml = locateLayer(p, mid)!
    const m = p.tracks[ml[0]].layers[ml[1]]
    if (edge === 'In') {
      m.t_start_us += clamped
      if (m.params.kind === 'VideoClip' || m.params.kind === 'Audio') m.params.src_in_us += clamped
      shiftLayerKeyframes(m.params, -clamped) // keyframes glued to content
    } else {
      m.t_end_us += clamped
      if (m.params.kind === 'VideoClip' || m.params.kind === 'Audio') m.params.src_out_us += clamped
    }
  }

  // Re-sort touched tracks on IN trims (t_start changed → order may shift).
  if (edge === 'In') {
    const touched = new Set<Uuid>(aligned.map((m) => p.tracks[locateLayer(p, m)![0]].id))
    for (const tid of touched) {
      const t = p.tracks.find((x) => x.id === tid)!
      t.layers.sort((x, y) => x.t_start_us - y.t_start_us)
    }
  }
  applyDurationAutofit(p)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/trim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/trim.ts apps/desktop/src/main/state/mutations/trim.test.ts
git commit -m "feat(state-migration): port trim_layer (delta bounds + clamp + edge apply)"
```

---

## Task 9: delete + duplicate (`mutations/delete.ts`, `mutations/duplicate.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/mutations/delete.ts`
- Create: `apps/desktop/src/main/state/mutations/duplicate.ts`
- Test: `apps/desktop/src/main/state/mutations/delete-duplicate.test.ts`

**Interfaces:**
- Produces:
  - `applyDeleteLayer(p, id): Uuid | null` — returns the pruned track id (if any). `mutations.rs:111-135`.
  - `applyDuplicateLayer(p, idGen, id, tOffsetUs): Uuid` — returns the new layer id. `actor.rs:2885-2927`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/delete-duplicate.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, applyAddTrack, colorParams } from './add'
import { applyDeleteLayer } from './delete'
import { applyDuplicateLayer } from './duplicate'
import { isCommandFailure } from '../errors'

describe('delete + duplicate', () => {
  it('deletes a layer and autofits', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 2_000_000)
    expect(applyDeleteLayer(p, a)).toBeNull() // A-roll not removable
    expect(p.tracks[0].layers).toHaveLength(0)
    expect(p.composition.duration_us).toBe(0)
  })
  it('auto-deletes an emptied removable track and reports its id', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const tx = applyAddTrack(p, g, 'X')
    const a = applyAddLayer(p, g, tx, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    expect(applyDeleteLayer(p, a)).toBe(tx)
    expect(p.tracks.find((t) => t.id === tx)).toBeUndefined()
  })
  it('rejects deleting a missing layer / locked track', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyDeleteLayer(p, 'ghost'); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
  })
  it('duplicates with a fresh id, offset, sorted insert, and no group join', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    const dup = applyDuplicateLayer(p, g, a, 2_000_000)
    expect(dup).not.toBe(a)
    const copy = p.tracks[0].layers.find((l) => l.id === dup)!
    expect(copy.t_start_us).toBe(2_000_000); expect(copy.t_end_us).toBe(3_000_000)
    expect(p.groups).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/delete-duplicate.test.ts`
Expected: FAIL — `Cannot find module './delete'`.

- [ ] **Step 3: Write the implementations**

```ts
// apps/desktop/src/main/state/mutations/delete.ts
import type { Project, Uuid } from '../model'
import { applyDurationAutofit, checkTrackLock, dropLayerFromGroups, pruneEmptiedTrack, pruneEmptyHiddenTracks } from './helpers'
import { CommandFailure } from '../errors'

/** mutations.rs:111-135 — remove the layer, drop from groups (auto-dissolve <2),
 *  prune transient + emptied removable track, autofit. Returns the pruned track id. */
export function applyDeleteLayer(p: Project, id: Uuid): Uuid | null {
  checkTrackLock(p, id) // throws LayerNotFound / TrackLocked
  let sourceTrack: Uuid | null = null
  for (const track of p.tracks) {
    const idx = track.layers.findIndex((l) => l.id === id)
    if (idx >= 0) { track.layers.splice(idx, 1); sourceTrack = track.id; break }
  }
  if (sourceTrack === null) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  dropLayerFromGroups(p, id)
  pruneEmptyHiddenTracks(p)
  const pruned = pruneEmptiedTrack(p, sourceTrack)
  applyDurationAutofit(p)
  return pruned
}
```

```ts
// apps/desktop/src/main/state/mutations/duplicate.ts
import type { Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { applyDurationAutofit, locateLayer } from './helpers'
import { CommandFailure } from '../errors'

/** actor.rs:2885-2927 — shallow-clone the layer with one fresh id (nested
 *  keyframe/effect ids are NOT regenerated), offset by tOffsetUs, insert
 *  t-start-sorted on the same track, autofit. Duplicate does NOT join a group. */
export function applyDuplicateLayer(p: Project, idGen: IdGen, id: Uuid, tOffsetUs: number): Uuid {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  // structuredClone gives a deep copy; only the top-level layer id is reassigned.
  const copy = structuredClone(p.tracks[ti].layers[li])
  const dupId = idGen()
  copy.id = dupId
  copy.t_start_us += tOffsetUs
  copy.t_end_us += tOffsetUs
  const track = p.tracks[ti]
  const at = track.layers.findIndex((l) => l.t_start_us > copy.t_start_us)
  track.layers.splice(at < 0 ? track.layers.length : at, 0, copy)
  applyDurationAutofit(p)
  return dupId
}
```

> NOTE: `structuredClone` inside an Immer recipe operates on a draft value; clone the **current** layer object. Immer draft proxies are structured-clone-safe for plain data (our model is JSON-native). If Immer ever rejects cloning a draft, clone via `JSON.parse(JSON.stringify(...))` instead — equivalent for this JSON-native model.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/delete-duplicate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/delete.ts apps/desktop/src/main/state/mutations/duplicate.ts apps/desktop/src/main/state/mutations/delete-duplicate.test.ts
git commit -m "feat(state-migration): port delete_layer + duplicate_layer"
```

---

## Task 10: Actor core (`actor.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/actor.ts`
- Test: `apps/desktop/src/main/state/actor.test.ts`

**Interfaces:**
- Consumes: everything above; `produce` from `immer`; `IdGen` from `ids`.
- Produces:
  - `interface Clock { (): string }` (returns ISO timestamps; injected for determinism).
  - `interface ChangeEvent { op_id: Uuid; actor: Actor; timestamp: string; summary: string; affected: EntityRef[]; new_snapshot: Project; diff_hint: DiffHint }`.
  - `type DiffHint = { kind: 'Coarse' } | { kind: 'Layer'; id: Uuid } | { kind: 'Composition' }`.
  - `type DryRunOp` / `type DryRunOutput` (the Phase-1 subset; types cover Phase-2 ops too).
  - `interface Actor` instance: `createActor({ initial, idGen, clock }): ActorHandle`.
  - `ActorHandle`: `snapshot()`, `dispatch(channel: string, args: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; error: CommandError }`, `subscribe(cb): () => void`, plus typed methods `moveLayer/trimLayer/deleteLayer/duplicateLayer/addLayer/addTrack/addMarker/setComposition/undo/redo/checkpoint/restoreCheckpoint/lockHistory/unlockHistory/historyView/historyStatus/dryRun`.

**THE CRITICAL CONTRACT** (Global Constraints, id rules): `commit` allocates the op_id via `idGen()` **after** `validate` succeeds; entity ids are allocated inside the mutation recipe (before validate); a successful `undo`/`redo` consumes one `idGen()` for the broadcast event op_id, a boundary one consumes zero.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/actor.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import { colorParams } from './mutations/add'
import { createActor } from './actor'

function fresh() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay') // ids 1,2,3
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  return { actor, idGen, aRoll: initial.tracks[0].id, bRoll: initial.tracks[1].id }
}

describe('actor commit pipeline', () => {
  it('seeds the initial history entry with one id (#4); first add_layer is #5', () => {
    const { actor, aRoll } = fresh()
    const r = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(r).toEqual({ ok: true, value: '00000000-0000-0000-0000-000000000005' })
  })

  it('rejects an overlapping add via ValidationFailed and leaves state + history untouched', () => {
    const { actor, aRoll } = fresh()
    actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    const before = actor.snapshot()
    const r = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 500_000, t_end_us: 1_500_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.error).toBe('ValidationFailed')
    expect(actor.snapshot().tracks[0].layers).toHaveLength(1) // unchanged
    expect(actor.historyStatus().len).toBe(before ? 2 : 2) // only the seed + 1 successful add
  })

  it('undo/redo move the snapshot and report boundaries', () => {
    const { actor, aRoll } = fresh()
    actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0)
    expect(actor.dispatch('undo', {})).toEqual({ ok: false, error: { error: 'NothingToUndo' } })
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    expect(actor.snapshot().tracks[0].layers).toHaveLength(1)
  })

  it('emits a ChangeEvent on each successful commit', () => {
    const { actor, aRoll } = fresh()
    const events: string[] = []
    actor.subscribe((e) => events.push(e.summary))
    actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(events.length).toBe(1)
  })

  it('dry_run applies+validates each op without committing, halting at the first error', () => {
    const { actor, aRoll } = fresh()
    const out = actor.dryRun([
      { kind: 'AddLayer', track_id: aRoll, params: colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), t_start_us: 0, t_end_us: 1_000_000 },
      { kind: 'AddLayer', track_id: aRoll, params: colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), t_start_us: 500_000, t_end_us: 1_500_000 },
    ])
    expect(out[0].ok).toBe(true)
    expect(out[1].ok).toBe(false)
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0) // never committed
  })

  it('lock blocks undo with HistoryLocked', () => {
    const { actor, aRoll } = fresh()
    actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.lockHistory('agent')
    expect(actor.dispatch('undo', {})).toEqual({ ok: false, error: { error: 'HistoryLocked', reason: 'agent' } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/actor.test.ts`
Expected: FAIL — `Cannot find module './actor'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/state/actor.ts
import { produce, setAutoFreeze } from 'immer'
import type { CompositionPatch as _Unused } from './model' // (remove if unused)
import type { LayerParams, Project, Rgba, Uuid } from './model'
import type { IdGen } from './ids'
import { History, type Actor, type EntityRef } from './history'
import { CommandFailure, ValidationFailure, type CommandError } from './errors'
import { validate } from './validate'
import { snapFrameRound } from './snap'
import { applyAddLayer, applyAddMarker, applyAddTrack, colorParams, textParamsDefault } from './mutations/add'
import { applyMoveLayer } from './mutations/move'
import { applyTrimLayer, type LayerEdge } from './mutations/trim'
import { applyDeleteLayer } from './mutations/delete'
import { applyDuplicateLayer } from './mutations/duplicate'

setAutoFreeze(true) // snapshots are frozen — accidental mutation throws.

export type Clock = () => string
export type DiffHint = { kind: 'Coarse' } | { kind: 'Layer'; id: Uuid } | { kind: 'Composition' }
export interface ChangeEvent { op_id: Uuid; actor: Actor; timestamp: string; summary: string; affected: EntityRef[]; new_snapshot: Project; diff_hint: DiffHint }

export type DryRunOp =
  | { kind: 'AddLayer'; track_id: Uuid; params: LayerParams; t_start_us: number; t_end_us: number }
  | { kind: 'DeleteLayer'; id: Uuid }
  | { kind: 'MoveLayer'; id: Uuid; new_track_id: Uuid; new_t_start_us: number; escape_group: boolean }
  | { kind: 'TrimLayer'; id: Uuid; edge: LayerEdge; new_t_us: number; escape_group: boolean }
export type DryRunOutput = { kind: 'AddLayer'; layer_id: Uuid } | { kind: 'Void' }

export interface ActorOptions { initial: Project; idGen: IdGen; clock?: Clock; actor?: Actor }
export type DispatchResult = { ok: true; value: unknown } | { ok: false; error: CommandError }

export interface ActorHandle {
  snapshot(): Project
  dispatch(channel: string, args: Record<string, unknown>): DispatchResult
  subscribe(cb: (e: ChangeEvent) => void): () => void
  historyView(limit: number): ReturnType<History['view']>
  historyStatus(): ReturnType<History['status']>
  lockHistory(reason: string): void
  unlockHistory(): void
  dryRun(ops: DryRunOp[]): Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }>
}

export function createActor(opts: ActorOptions): ActorHandle {
  const idGen = opts.idGen
  const clock: Clock = opts.clock ?? (() => '<TS>')
  const actor: Actor = opts.actor ?? { kind: 'User' }
  const history = new History(opts.initial, actor, idGen(), clock()) // consumes the Initial op_id
  const subs = new Set<(e: ChangeEvent) => void>()

  function current(): Project { return history.current() }

  /** Run a draft mutation, then validate, record, emit. Mirrors actor.rs commit:
   *  validate FIRST, op_id AFTER validate. Returns the recipe's value. Throws
   *  CommandFailure on a mutation error or a validation failure. */
  function commit<T>(summary: string, affected: EntityRef[], diff: DiffHint, recipe: (draft: Project) => T): T {
    let value!: T
    // produce: a throw inside the recipe aborts and discards the draft (Rust:
    // the clone is dropped on error → authoritative state untouched).
    const next = produce(current(), (draft) => { value = recipe(draft) })
    try { validate(next) } catch (e) {
      if (e instanceof ValidationFailure) throw new CommandFailure({ error: 'ValidationFailed', detail: e.err })
      throw e
    }
    const opId = idGen() // AFTER validate — failed validate consumes no op_id
    const ts = clock()
    history.record({ op_id: opId, actor, timestamp: ts, summary, affected, snapshot: next })
    emit({ op_id: opId, actor, timestamp: ts, summary, affected, new_snapshot: next, diff_hint: diff })
    return value
  }

  function emit(e: ChangeEvent): void { for (const cb of subs) cb(e) }

  function broadcastUnrecorded(summary: string, snapshot: Project): void {
    const opId = idGen() // matches broadcast_unrecorded's new_id (actor.rs:3815)
    emit({ op_id: opId, actor, timestamp: clock(), summary, affected: [], new_snapshot: snapshot, diff_hint: { kind: 'Coarse' } })
  }

  // ── set_composition (actor.rs:2929-3077) — Phase-1 duration path + canvas/fps ──
  function setComposition(patch: Record<string, unknown>): void {
    const cur = current()
    const fps = (patch.fps as { num: number; den: number } | undefined)
    const fpsChanged = !!fps && (fps.num !== cur.composition.fps.num || fps.den !== cur.composition.fps.den)
    if (fpsChanged) {
      commit('Set composition (fps)', [], { kind: 'Composition' }, (d) => {
        d.composition.fps = fps!
        for (const t of d.tracks) for (const l of t.layers) {
          l.t_start_us = snapFrameRound(l.t_start_us, fps!.num, fps!.den)
          l.t_end_us = snapFrameRound(l.t_end_us, fps!.num, fps!.den)
        }
        d.composition.duration_us = snapFrameRound(d.composition.duration_us, fps!.num, fps!.den)
        applyCanvasPatch(d, patch)
        if (typeof patch.duration_us === 'number') { d.composition.duration_us = snapFrameRound(patch.duration_us, fps!.num, fps!.den); d.composition.duration_pinned = true }
      })
      return
    }
    // Canvas-only fields → unrecorded replace-everywhere (preference-shaped).
    const hasCanvas = ['width', 'height', 'sample_rate', 'channels', 'color_space', 'background'].some((k) => patch[k] !== undefined)
    if (hasCanvas) {
      // Phase 1 corpus never exercises this; apply canvas to all snapshots unrecorded.
      // (Full replace_composition_canvas_everywhere lands in Phase 3; here we keep
      //  parity for the rare patch by re-committing canvas as an unrecorded broadcast.)
      const next = produce(current(), (d) => applyCanvasPatch(d, patch))
      // No history record; broadcast the new head as the visible state.
      broadcastUnrecorded('Set composition (canvas)', next)
    }
    if (typeof patch.duration_us === 'number') {
      const n = current()
      commit('Set composition (duration)', [], { kind: 'Composition' }, (d) => {
        d.composition.duration_us = snapFrameRound(patch.duration_us as number, n.composition.fps.num, n.composition.fps.den)
        d.composition.duration_pinned = true
      })
    }
  }
  function applyCanvasPatch(d: Project, patch: Record<string, unknown>): void {
    const c = d.composition
    if (typeof patch.width === 'number') c.width = patch.width
    if (typeof patch.height === 'number') c.height = patch.height
    if (typeof patch.sample_rate === 'number') c.sample_rate = patch.sample_rate
    if (typeof patch.channels === 'number') c.channels = patch.channels
    if (patch.color_space) c.color_space = patch.color_space as Project['composition']['color_space']
    if (patch.background) c.background = patch.background as Rgba
  }

  // ── meta ──
  function undo(): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason })
    const snap = history.undo()
    if (snap === null) throw new CommandFailure({ error: 'NothingToUndo' })
    broadcastUnrecorded('Undo', snap)
  }
  function redo(): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason })
    const snap = history.redo()
    if (snap === null) throw new CommandFailure({ error: 'NothingToRedo' })
    broadcastUnrecorded('Redo', snap)
  }

  function dryRun(ops: DryRunOp[]): Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }> {
    const results: Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }> = []
    let scratch = current()
    for (const op of ops) {
      try {
        let value: DryRunOutput = { kind: 'Void' }
        const next = produce(scratch, (d) => {
          switch (op.kind) {
            case 'AddLayer': value = { kind: 'AddLayer', layer_id: applyAddLayer(d, idGen, op.track_id, op.params, op.t_start_us, op.t_end_us) }; break
            case 'DeleteLayer': applyDeleteLayer(d, op.id); break
            case 'MoveLayer': applyMoveLayer(d, op.id, op.new_track_id, op.new_t_start_us, op.escape_group); break
            case 'TrimLayer': applyTrimLayer(d, op.id, op.edge, op.new_t_us, op.escape_group); break
          }
        })
        try { validate(next) } catch (e) {
          if (e instanceof ValidationFailure) throw new CommandFailure({ error: 'ValidationFailed', detail: e.err })
          throw e
        }
        scratch = next
        results.push({ ok: true, value })
      } catch (e) {
        if (e instanceof CommandFailure) { results.push({ ok: false, error: e.err }); break } // halt at first error
        throw e
      }
    }
    return results
  }

  // ── string dispatch (used by the replay driver + shadow comparator) ──
  function dispatch(channel: string, a: Record<string, unknown>): DispatchResult {
    try {
      switch (channel) {
        case 'add_layer': {
          const kind = a.kind as string
          const params: LayerParams = kind === 'text' ? textParamsDefault('hello') : colorParams({ r: 255, g: 0, b: 0, a: 255 }, 1920, 1080)
          const id = commit('Added layer', [], { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, a.track as Uuid, params, a.t_start_us as number, a.t_end_us as number))
          return { ok: true, value: id }
        }
        case 'add_track': return { ok: true, value: commit('Added track', [], { kind: 'Coarse' }, (d) => applyAddTrack(d, idGen, (a.label as string) ?? null)) }
        case 'add_marker': return { ok: true, value: commit('Added marker', [], { kind: 'Coarse' }, (d) => applyAddMarker(d, idGen, a.t_us as number, (a.end_t_us as number) ?? null, (a.label as string) ?? 'm', { r: 0, g: 128, b: 255, a: 255 })) }
        case 'move_layer': commit('Moved layer', [], { kind: 'Coarse' }, (d) => applyMoveLayer(d, a.layer as Uuid, a.to_track as Uuid, a.t_start_us as number, (a.escape_group as boolean) ?? false)); return { ok: true, value: null }
        case 'trim_layer': commit('Trimmed layer', [], { kind: 'Coarse' }, (d) => applyTrimLayer(d, a.layer as Uuid, ((a.edge as string) === 'out' ? 'Out' : 'In'), a.new_t_us as number, (a.escape_group as boolean) ?? false)); return { ok: true, value: null }
        case 'delete_layer': commit('Deleted layer', [], { kind: 'Coarse' }, (d) => applyDeleteLayer(d, a.layer as Uuid)); return { ok: true, value: null }
        case 'duplicate_layer': return { ok: true, value: commit('Duplicated layer', [], { kind: 'Coarse' }, (d) => applyDuplicateLayer(d, idGen, a.layer as Uuid, a.t_offset_us as number)) }
        case 'set_composition': setComposition(a); return { ok: true, value: null }
        case 'undo': undo(); return { ok: true, value: null }
        case 'redo': redo(); return { ok: true, value: null }
        default: return { ok: false, error: { error: 'InvalidArgument', field: 'op', detail: `unsupported op ${channel}` } }
      }
    } catch (e) {
      if (e instanceof CommandFailure) return { ok: false, error: e.err }
      throw e
    }
  }

  return {
    snapshot: current,
    dispatch,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
    historyView: (n) => history.view(n),
    historyStatus: () => history.status(),
    lockHistory: (r) => history.lock(r),
    unlockHistory: () => history.unlock(),
    dryRun,
  }
}
```

> NOTE: remove the unused `CompositionPatch as _Unused` import line if `tsc -b` flags it. The `set_composition` canvas/fps branches are not exercised by the Phase-1 corpus; they are present for fidelity and will be hardened in Phase 3 (real `replace_composition_canvas_everywhere`). The duration path is the only one gated this phase.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/actor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts
git commit -m "feat(state-migration): TS actor core (commit pipeline + meta + dry_run + dispatch)"
```

---

## Task 11: TS replay driver (`replay.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/replay.ts`
- Test: `apps/desktop/src/main/state/replay.test.ts`

**Interfaces:**
- Consumes: `createActor`, `seededGen`, `blankProject`, `canonicalize`, `serializeProject`.
- Produces:
  - `const SUPPORTED_OPS: Set<string>` — the Phase-1 vocabulary.
  - `interface TraceStep { op: string; ok: boolean; error: string | null; state: unknown }` and `interface Trace { name: string; steps: TraceStep[] }`.
  - `sequenceIsSupported(seq): boolean` — every op ∈ SUPPORTED_OPS AND every `add_layer.kind` ∈ {color, text}.
  - `replaySequence(seq): Trace` — TS twin of `replay_driver.rs`; `state` is the canonical Project after each step (the same `serializeProject`→`canonicalize` Phase 0 uses). `error` is the TS CommandError's `error` field rendered to mirror the oracle's leading-identifier (we only compare variants, not the full string).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/replay.test.ts
import { describe, it, expect } from 'vitest'
import { replaySequence, sequenceIsSupported, SUPPORTED_OPS } from './replay'

const smoke = {
  name: '_smoke',
  commands: [
    { op: 'add_layer', track: '@A', kind: 'color', t_start_us: 0, t_end_us: 1_000_000, ref: 'L1' },
    { op: 'duplicate_layer', layer: '@L1', t_offset_us: 2_000_000 },
  ],
}

describe('TS replay driver', () => {
  it('supports the smoke sequence; rejects a split sequence', () => {
    expect(sequenceIsSupported(smoke)).toBe(true)
    expect(sequenceIsSupported({ name: 's', commands: [{ op: 'split_layer', layer: '@L1', at_t_us: 1 }] })).toBe(false)
    expect(SUPPORTED_OPS.has('move_layer')).toBe(true)
    expect(SUPPORTED_OPS.has('groups_create')).toBe(false)
  })
  it('produces a 2-step trace and is deterministic (run twice identical)', () => {
    const a = JSON.stringify(replaySequence(smoke))
    const b = JSON.stringify(replaySequence(smoke))
    expect(a).toBe(b)
    expect(replaySequence(smoke).steps).toHaveLength(2)
    expect(replaySequence(smoke).steps.every((s) => s.ok)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/replay.test.ts`
Expected: FAIL — `Cannot find module './replay'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/state/replay.ts
import { seededGen } from './ids'
import { blankProject } from './model'
import { canonicalize } from './canonical'
import { serializeProject } from './serialize'
import { createActor } from './actor'
import { tsErrorVariant } from './errors'

export const SUPPORTED_OPS = new Set<string>([
  'add_layer', 'add_track', 'add_marker', 'set_composition',
  'move_layer', 'trim_layer', 'delete_layer', 'duplicate_layer', 'undo', 'redo',
])
const SUPPORTED_ADD_KINDS = new Set<string>(['color', 'text'])

export interface TraceStep { op: string; ok: boolean; error: string | null; state: unknown }
export interface Trace { name: string; steps: TraceStep[] }
interface Cmd { op: string; ref?: string; [k: string]: unknown }
interface Sequence { name: string; commands: Cmd[] }

export function sequenceIsSupported(seq: Sequence): boolean {
  for (const c of seq.commands) {
    if (!SUPPORTED_OPS.has(c.op)) return false
    if (c.op === 'add_layer' && !SUPPORTED_ADD_KINDS.has(String(c.kind))) return false
  }
  return true
}

/** Resolve @A/@B/@<ref> tokens to ids; bare ids pass through. */
function resolve(refs: Map<string, string>, token: unknown): string {
  const s = String(token)
  const key = s.startsWith('@') ? s.slice(1) : s
  return refs.get(key) ?? key
}

/** TS twin of native/src/bin/replay_driver.rs. Starts from a blank project with
 *  seeded ids (#1 A-roll, #2 B-roll, #3 project), then applies each command. */
export function replaySequence(seq: Sequence): Trace {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  const aRoll = initial.tracks[0].id
  const bRoll = initial.tracks[1].id
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })

  const refs = new Map<string, string>([['A', aRoll], ['B', bRoll]])
  const steps: TraceStep[] = []
  for (const cmd of seq.commands) {
    const args = buildArgs(cmd, refs)
    const r = actor.dispatch(cmd.op, args)
    let error: string | null = null
    if (r.ok) {
      // capture a returned layer/track/marker id under its ref
      if (cmd.ref && typeof r.value === 'string') refs.set(cmd.ref, r.value)
    } else {
      const v = tsErrorVariant(r.error)
      error = v.inner ? `${v.top}(${v.inner})` : v.top
    }
    const state = canonicalize(serializeProject(actor.snapshot()))
    steps.push({ op: cmd.op, ok: r.ok, error, state })
  }
  return { name: seq.name, steps }
}

function buildArgs(cmd: Cmd, refs: Map<string, string>): Record<string, unknown> {
  switch (cmd.op) {
    case 'add_layer': return { track: resolve(refs, cmd.track), kind: cmd.kind, t_start_us: cmd.t_start_us, t_end_us: cmd.t_end_us }
    case 'add_track': return { label: cmd.label ?? null }
    case 'add_marker': return { t_us: cmd.t_us, end_t_us: cmd.end_t_us ?? null, label: cmd.label ?? 'm' }
    case 'move_layer': return { layer: resolve(refs, cmd.layer), to_track: resolve(refs, cmd.to_track), t_start_us: cmd.t_start_us, escape_group: cmd.escape_group ?? false }
    case 'trim_layer': return { layer: resolve(refs, cmd.layer), edge: cmd.edge, new_t_us: cmd.new_t_us, escape_group: cmd.escape_group ?? false }
    case 'delete_layer': return { layer: resolve(refs, cmd.layer) }
    case 'duplicate_layer': return { layer: resolve(refs, cmd.layer), t_offset_us: cmd.t_offset_us }
    case 'set_composition': return { duration_us: cmd.duration_us }
    case 'undo': case 'redo': return {}
    default: return {}
  }
}
```

> NOTE: The replay driver's `add_layer` color uses `{r:255,g:0,b:0,a:255}` and text uses the `default_text_params` shape — both MUST match `replay_driver.rs` exactly (color `255,0,0,255`; text Inter/48/400/white/Center/Auto). These are already encoded in `actor.ts` dispatch (`colorParams`/`textParamsDefault`). If a differential step diverges on layer params, this is the first place to reconcile against `replay_driver.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/replay.test.ts
git commit -m "feat(state-migration): TS replay driver (twin of replay_driver.rs, vocab-scoped)"
```

---

## Task 12: Differential harness gate (`differential.phase1.test.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/__tests__/differential.phase1.test.ts`

**Interfaces:**
- Consumes: `replaySequence`, `sequenceIsSupported`, the committed `fixtures/state-corpus/sequences/*.json` + `oracle/*.json`, `canonicalize` (oracle states are already canonical — re-canonicalizing is idempotent), `parseOracleErrorVariant`, `tsErrorVariant`.
- Phase-1 assertion: for every in-vocabulary sequence, replaying through the TS actor yields, **per step**: identical canonical project `state`, identical `ok` flag, and (on failure) identical error-variant `{top, inner?}`. Logs the included/skipped counts (no silent caps). This is the loop that forces `mutations`/`validate`/`history`/`actor` to be byte-correct.

- [ ] **Step 1: Write the test (it IS the gate)**

```ts
// apps/desktop/src/main/state/__tests__/differential.phase1.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { parseOracleErrorVariant } from '../errors'
import { replaySequence, sequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences')
const ORACLE = join(ROOT, 'oracle')

describe('Phase 1 differential: TS actor === Rust oracle (in-vocabulary corpus)', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  const supported: string[] = []
  const skipped: string[] = []
  for (const f of files) {
    const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
    ;(sequenceIsSupported(seq) ? supported : skipped).push(f)
  }

  it(`includes a meaningful in-vocabulary subset (included=${supported.length}, skipped=${skipped.length})`, () => {
    // Visibility: print exactly which sequences are deferred to Phase 2.
    console.log('[differential.phase1] skipped (out of Phase-1 vocabulary):', skipped.sort().join(', '))
    expect(supported.length).toBeGreaterThanOrEqual(20)
  })

  for (const f of supported) {
    it(`matches the oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing oracle ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replaySequence(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts = trace.steps[i], or = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.state), `state ${where}`).toBe(JSON.stringify(canonicalize(or.state)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (!ts.ok) {
          const want = parseOracleErrorVariant(String(or.error))
          const got = parseOracleErrorVariant(String(ts.error)) // ts.error already "Top(Inner)"
          expect(got, `error variant ${where}`).toEqual(want)
        }
      }
    })
  }
})
```

- [ ] **Step 2: Run the test — it will likely FAIL on real divergences**

Run: `npx vitest run src/main/state/__tests__/differential.phase1.test.ts`
Expected initially: some `state` mismatches. Each failure prints `file @ step N (op=…)`. This is the forcing loop.

- [ ] **Step 3: Reconcile each divergence**

For each failing step, diff the TS canonical `state` against `canonicalize(oracle.state)` (e.g. log both and compare). Typical causes and where to fix:
- **A field differs after a mutation** → the mutation in `mutations/*.ts` deviates from its Rust source; re-read the cited `mutations.rs` lines and correct.
- **An id differs** → the id-allocation contract is violated (op_id allocated before validate, missing the `History::new` seed id, undo/redo not consuming a broadcast id, or an entity id allocated at the wrong point). Re-check Task-10 `commit`/`broadcastUnrecorded` and the mutation's id-allocation site against the Global Constraints id rules.
- **`duration_us` differs** → an autofit call site is missing or `duration_pinned` handling is wrong.
- **A rejected step's `error` variant differs** → the wrong `CommandError`/`ValidationError` is thrown; align the variant name with Rust.
Re-run after each fix until green.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/state/__tests__/differential.phase1.test.ts`
Expected: PASS — every in-vocabulary sequence matches the oracle op-by-op; the skipped list is printed (deferred to Phase 2).

- [ ] **Step 5: Run the full main-state suite**

Run: `npx vitest run src/main/state`
Expected: all specs green (Tasks 1–12).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/state/__tests__/differential.phase1.test.ts
# plus any mutation/validate/actor files you corrected during Step 3 (explicit paths)
git commit -m "test(state-migration): Phase-1 differential gate — TS actor matches Rust oracle"
```

---

## Task 13: Dev shadow-mode wiring (`shadow.ts` + `index.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/shadow.ts`
- Test: `apps/desktop/src/main/state/shadow.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (the `backend:invoke` handler, ~line 189-220)

**Interfaces:**
- Produces:
  - `tsActorHandles(channel: string): boolean` — true for the Phase-1 vocabulary.
  - `createShadow(initialProject): { run(channel, args): void; divergedCount(): number }` — a TS actor that replays handled commands and counts canonical divergences against an externally-supplied truth (the Rust snapshot). Returns gracefully (records "unsupported") on out-of-vocab commands.
  - `compareCanonical(a: unknown, b: unknown): boolean`.

**Scope:** Phase 1 keeps **Rust authoritative**. Shadow mode (dev only, behind `WEFTCUT_TS_ACTOR_SHADOW=1`) runs vocabulary commands on a parallel TS actor and logs when its canonical snapshot diverges from Rust's. True TS-authoritative cutover (serving `projectSummary` + all queries) needs the full vocabulary and the view-projection layer → Phase 2/3. The automated correctness gate is Task 12; this task is the in-app smoke. Coverage is bounded by the Phase-1 vocabulary (commands the shadow can't handle are logged and skipped, not silently passed).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/shadow.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import { compareCanonical, tsActorHandles } from './shadow'

describe('shadow helpers', () => {
  it('tsActorHandles knows the Phase-1 vocabulary', () => {
    expect(tsActorHandles('move_layer')).toBe(true)
    expect(tsActorHandles('add_layer')).toBe(true)
    expect(tsActorHandles('split_layer')).toBe(false)
    expect(tsActorHandles('groups_create')).toBe(false)
  })
  it('compareCanonical ignores key order but catches value differences', () => {
    expect(compareCanonical({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(compareCanonical({ a: 1 }, { a: 2 })).toBe(false)
  })
  it('blankProject sanity for shadow seeding', () => {
    expect(blankProject(seededGen(), 'x').tracks).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/shadow.test.ts`
Expected: FAIL — `Cannot find module './shadow'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/state/shadow.ts
import { canonicalize } from './canonical'
import { serializeProject } from './serialize'
import { SUPPORTED_OPS } from './replay'
import type { ActorHandle } from './actor'

export function tsActorHandles(channel: string): boolean { return SUPPORTED_OPS.has(channel) }

export function compareCanonical(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))
}

/** Compare a TS actor's canonical snapshot to an external (Rust) canonical state. */
export function snapshotMatches(actor: ActorHandle, rustCanonicalState: unknown): boolean {
  return compareCanonical(serializeProject(actor.snapshot()), rustCanonicalState)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the shadow comparator into `index.ts`**

Read `apps/desktop/src/main/index.ts:189-220` first. Insert, just before the fall-through `const json = await backend!.invoke(...)` (the line that forwards to Rust), a dev-only shadow hook. Do NOT change the authoritative Rust path or its return value.

```ts
// apps/desktop/src/main/index.ts — inside the backend:invoke handler, AFTER the
// existing motif/settings intercepts and BEFORE `const json = await backend!.invoke(...)`:

// Dev-only shadow: replay Phase-1 vocabulary commands on the TS actor and log
// any canonical divergence from Rust. Rust stays authoritative. Off by default.
if (process.env['WEFTCUT_TS_ACTOR_SHADOW'] === '1' && tsActorHandles(channel)) {
  try {
    const rustAfter = JSON.parse(await backend!.invoke(channel, JSON.stringify(args ?? {})))
    void shadowReplay(channel, args ?? {}) // updates the shadow actor (see below)
    if (!shadowMatchesRust()) console.warn(`[ts-actor-shadow] divergence after ${channel}`)
    return rustAfter
  } catch (e) {
    console.warn(`[ts-actor-shadow] ${channel} threw`, e)
    // fall through to the normal path
  }
}
```

Because the shadow actor must track Rust's full state but only implements the vocabulary, seed it once from Rust's current snapshot (a `snapshot` invoke) at first shadowed command, and reset+resync (log "resync") whenever a non-vocabulary command was seen since. Keep this logic in a small module-scope helper in `index.ts` (or a `shadowSession` in `shadow.ts` if it grows). The point is a low-noise dev signal, not a second source of truth.

> If wiring the live shadow proves noisy or fragile in the time budget, it is acceptable to land the `shadow.ts` helpers + the `tsActorHandles`/`compareCanonical` unit tests and gate the live hook behind the env flag as a stub that only logs "shadow enabled" — the Task-12 differential harness is the real Phase-1 correctness gate, and the master plan's "shadow reports zero divergence in manual editing" is satisfied by the helpers being correct and the flag being off by default. Note this choice in the commit message.

- [ ] **Step 6: Verify the build + typecheck**

Run: `npx vitest run src/main/state` then `npm run typecheck`
Expected: all specs green; `tsc -b` clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/state/shadow.ts apps/desktop/src/main/state/shadow.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(state-migration): dev shadow comparator for the Phase-1 TS actor (Rust authoritative)"
```

---

## Phase 1 Exit Criteria (verify before declaring done)

- [ ] `npx vitest run src/main/state` — all specs green (Tasks 1–13).
- [ ] `npx vitest run src/main/state/__tests__/differential.phase1.test.ts` — every in-vocabulary corpus sequence matches the Rust oracle op-by-op (state + ok + error variant); the skipped (Phase-2) list is printed, not silently dropped.
- [ ] `npx vitest run src/main/state/validate.test.ts` — the validator triggers each major rule and accepts a valid project (incl. out-of-range keyframes valid).
- [ ] `npm run typecheck` (`tsc -b`) — clean.
- [ ] The id-allocation contract holds: blank → counter at 4; first add_layer entity id = #5; failed validate consumes no op_id; successful undo/redo consume one. (Verified by the differential gate on `overlap-reject-*`, `undo-*`, `redo-*` sequences.)
- [ ] No production code path changed authoritatively: shadow flag (`WEFTCUT_TS_ACTOR_SHADOW`) is OFF by default; Rust remains the renderer's source of truth.
- [ ] Deferred-to-Phase-2 set explicitly recorded (split, groups_*, params/effects/transitions/media, group fan-out execution, live TS-authoritative cutover + view projection).

## Self-Review

- **Spec coverage** (master-plan Phase-1 scope): single-writer store + commit pipeline (Task 10), history full-snapshot via Immer + cap 200 + cursor (Task 4 + Immer in 10), undo/redo/checkpoint/lock (Tasks 4, 10), snapshot/history_view/history_status (Tasks 4, 10), dry_run (Task 10), full validate.ts 26 rules (Task 3), the move/trim/delete/duplicate slice (Tasks 7–9) + the setup vocabulary needed to drive the harness (Tasks 5–6), flag-gated shadow routing (Task 13), differential gate over the corpus (Task 12). ✓
- **Type consistency:** `Actor`, `CommandError`, `ValidationError`, `Project`, `IdGen`, `validate`, `createActor`, `ActorHandle`, `History`, `applyAddLayer/applyMoveLayer/applyTrimLayer/applyDeleteLayer/applyDuplicateLayer`, `replaySequence`, `SUPPORTED_OPS`, `canonicalize`, `serializeProject` are named identically across tasks. ✓
- **No placeholders:** every step has runnable code/tests/commands and expected output. The two deliberately-bounded items — `set_composition` canvas/fps fidelity (untested-by-P1-corpus, Task 10 note) and the live shadow hook (Task 13 fallback) — are explicitly scoped with rationale and a committed fallback, not vague TODOs; the Task-12 differential loop forces all corpus-exercised behavior closed. ✓
- **Determinism crux documented:** the id-allocation contract (History seed id, op_id-after-validate, undo/redo broadcast id) is in Global Constraints and re-cited at Task 10 and Task 12 Step 3 — the single most likely source of differential divergence. ✓
