# State-Actor TS Migration — Phase 2b-iv Plan (transitions + set_composition-full)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the FOURTH slice of **Phase 2b** of the master plan `2026-06-22-state-actor-ts-migration.md`. Read the **Phase-2b-iii plan** (`…-phase-2b-iii.md`) first — it established the per-slice workflow (port TS mutation → unit-test → extend dispatch+vocab+driver → author corpus → regen oracles → differential-gate) and the id-contract discipline this slice depends on. This slice ports the two **transition** ops and completes the **`set_composition`** mutation (fps re-snap + canvas replace-everywhere).

**Goal:** Port and differential-gate `add_transition`/`remove_transition` (the authorized same-track overlap) AND finish `set_composition` so the fps frame re-snap, canvas-everywhere replacement, and atomic combined-validate all match the Rust oracle byte-for-byte.

**Architecture:** Same as Phase 1/2a/2b-* — pure functions over an Immer draft, 1:1 with the authoritative Rust. The transition ops live in `actor.rs` as `do_add_transition`/`do_remove_transition` (NOT the `apply_*` family); we mirror them as `mutations/transitions.ts` pure functions wrapped by the actor's generic `commit`. `set_composition` is finished in-place in `actor.ts` against `do_set_composition` (actor.rs:2929-3077), adding `History.replaceCompositionCanvasEverywhere` (history.rs:246). The differential corpus grows by ~13 sequences; the Rust `replay_driver` gains two transition arms and an extended `set_composition` arm; the gate (`differential.phase2.test.ts`) auto-picks-up new sequences once vocabulary + oracles exist.

**Tech Stack:** TypeScript, Immer, Vitest, the `weftcut-eval` wasm leaf (`snapFrameRound`, UNCHANGED), the Rust `replay_driver` bin + `gen-state-oracle.mjs` (needs the cargo/ffmpeg toolchain).

## Global Constraints

- **The oracle-regeneration toolchain (verified working through 2b-iii).** Regenerating oracles builds `replay_driver` (compiles the native crate incl. ffmpeg-next). Set these env vars before any `cargo`/regen, then run from `apps/desktop/`:
  ```bash
  export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
  export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
  export PATH="$FFMPEG_DIR/bin:$PATH"
  node scripts/gen-state-oracle.mjs   # builds replay_driver, runs each sequence 2× (determinism gate), writes oracle/*.json
  ```
  The build feature set is baked into `gen-state-oracle.mjs` (`--features replay,jobs,export,mcp,cloud,motifs`; bare `replay` fails on a pre-existing `napi_backend.rs` error). **Every driver change in this slice is ADDITIVE** — after a regen, the **103 pre-existing oracles must be byte-identical**; only NEW oracle files may appear. Verify with `git status --short fixtures/state-corpus/oracle/` after each regen (only `??` new files, never `M`). If an existing oracle shows Modified, STOP — the change wasn't additive; investigate.
- **Baseline:** the corpus currently holds **103 sequences / 103 oracles**; `differential.phase2.test.ts` runs all 103 with `skipped === []`.
- **Gate-ordering invariant (why task order matters).** `differential.phase2.test.ts` asserts `skipped === []` over the LIVE corpus dir, and `gen-state-oracle.mjs` runs the Rust driver over the LIVE corpus dir. So for any new op X: X must be in TS `SUPPORTED_OPS` + `buildArgs` + a dispatch arm + its mutation, AND in the Rust driver's `apply()`, **before** any corpus sequence using X exists. Never add a corpus sequence whose op isn't already supported on BOTH sides. (Tasks 1 + 3 land TS mutations + unit tests with NO corpus; Tasks 2 + 4 wire dispatch+vocab+driver and only THEN author the corpus.)
- **★ KEYSTONE LANDMINE — `add_transition` mints the transition id AFTER the checks but BEFORE `commit`, so a `ValidationFailed` (not `LayerNotFound`/`TransitionLayersNotAdjacent`) burns it.** `do_add_transition` (actor.rs:3200) returns early on `LayerNotFound`/`TransitionLayersNotAdjacent` **before** `new_id()` (so those failures burn NO id — the `add_layer` pattern), then mints `new_id()`, pushes the transition, and calls `self.commit`. `commit` runs `validate` and only AFTER validate mints the op_id (actor.rs:3787-3789). So if the transition is structurally valid enough to reach `commit` but `validate` rejects the post-state (e.g. `LayerInMultipleTransitions`), the **transition id is burned but no op_id is** — every later id shifts by one. This is a THIRD id-burn pattern (contrast: `add_layer` burns nothing on failure; `add_effect` burns on `LayerNotFound`). The TS `applyAddTransition` MUST call `idGen()` at the same point — after the layer + adjacency logic, before pushing — inside the `commit` recipe (so produce→throw on the early failures skips `idGen`; produce→success then validate-fail still burned it). Gated by `add-transition-validate-fail-burns-id.json` AND a `mutations/transitions.test.ts` unit test.
- **id contract (otherwise unchanged):** `commit` allocates the op_id AFTER `validate`; a successful recorded op burns one op_id; a failed mutation or failed validate burns no op_id. `add_transition` additionally burns one entity id (the transition id) ONLY on the validate-fail path (per the keystone). `remove_transition` mints NO entity id. `set_composition`'s fps path is ONE recorded commit (one op_id); the non-fps canvas path is unrecorded but `broadcast_unrecorded` burns one id (matching `broadcastUnrecorded`, actor.rs:3815); the non-fps duration path is one recorded commit.
- **The wasm snap leaf is sacred** — `snapFrameRound(value, num, den)` from `../snap`, never reimplemented. **TimeUs is `number`.**
- **`mutations/transitions.ts` is NEW** but the data types already exist: `Transition { id, from_layer, to_layer, duration_us, kind: { kind: 'Crossfade' } }` and `Project.transitions: Transition[]` are in model.ts:81,101; `serializeProject` is identity over `transitions` and `canonicalize` sorts keys recursively, so no serde/canonical work is required. The validator already enforces ALL transition rules (`validateTransitions`, validate.ts:29-60) and composition rules (`validateComposition`, validate.ts:22-26) — no `validate.ts` change. All transition `CommandError` variants (`LayerNotFound`, `TransitionNotFound`, `TransitionLayersNotAdjacent`) and the transition `ValidationError` variants are already in `errors.ts` — no `errors.ts` change.
- **Transitions are a backend skeleton (no napi/MCP/UI), but the `ProjectHandle::add_transition`/`remove_transition` methods ARE implemented** (actor.rs:1532-1566) — the differential driver calls them directly, exactly as the Rust unit tests do. There is only one `TransitionKind` (`Crossfade`).
- Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `git add` by **explicit path only** (parallel sessions — [[feedback_parallel_sessions_git]]). Work on local `main`; do NOT push. TDD, frequent commits, DRY, YAGNI.

### Reference Rust sources (cite; re-read only if a differential step diverges)

- Transition data model: `native/src/state/transition.rs` (`Transition`, `TransitionKind::Crossfade`).
- Transition mutations: `do_add_transition` / `do_remove_transition` — `native/src/state/actor.rs:3200-3305`.
- Transition handles: `add_transition` / `remove_transition` — `native/src/state/actor.rs:1532-1566`.
- Layer extend/shrink helpers: `extend_layer_t_end` / `shrink_layer_t_end` — `native/src/state/actor/mutations.rs:1412-1431` (touch `t_end_us`, AND `src_out_us` for `VideoClip`/`Audio`; shrink saturates at 0).
- `commit` (validate → op_id) — `native/src/state/actor.rs:3779-3809`. `broadcast_unrecorded` (burns one id) — `:3811-3820`.
- `set_composition`: `do_set_composition` — `native/src/state/actor.rs:2929-3077`. `CompositionPatch` — `:305-322`. `replace_composition_canvas_everywhere` + `apply_canvas_fields` (7 canvas fields: width/height/fps/sample_rate/channels/color_space/background) — `native/src/state/history.rs:246-257, 391-399`.
- `apply_duration_autofit` (TS twin already exists: `applyDurationAutofit`, helpers.ts:15) — `native/src/state/actor/mutations.rs:28-42`.
- TS pieces already in place: `Transition`/`Project.transitions` (model.ts:81,101); validator (validate.ts:22-60); errors (errors.ts:7-13,29,32,33); the `commit`/dispatch idiom + the existing partial `setComposition` to be rewritten (actor.ts:85-128); the existing `add_layer` id-after-check contrast (add.ts).

---

## File Structure

All paths under `apps/desktop/`. Vitest from `apps/desktop/` (`npx vitest run <path>`).

| Path | Responsibility | New/Mod |
|---|---|---|
| `src/main/state/mutations/transitions.ts` | `extendLayerTEnd`/`shrinkLayerTEnd` helpers; `applyAddTransition` (id minted after checks), `applyRemoveTransition` (shrink-back). | **New** |
| `src/main/state/mutations/transitions.test.ts` | Unit tests incl. the validate-fail id-burn landmine + the src_out_us extend/shrink branch + the unreachable-via-API pre-overlap case. | **New** |
| `src/main/state/history.ts` | `replaceCompositionCanvasEverywhere(canvas)` (mirror history.rs:246). | Mod |
| `src/main/state/history.test.ts` | Canvas-everywhere unit test (patches all snapshots, cursor unchanged). | Mod |
| `src/main/state/actor.ts` | Two transition dispatch arms; full `setComposition` rewrite (atomic combined-probe validate, fps re-snap incl. Motif `src_in_us`, autofit, canvas replace-everywhere). Extract `runValidate` shared by `commit`. | Mod |
| `src/main/state/actor.test.ts` | Transition dispatch describe block; `set_composition` fps/canvas/mixed/undo dispatch describe block. | Mod |
| `src/main/state/replay.ts` | `SUPPORTED_OPS` += `add_transition`/`remove_transition`; `buildArgs` for both + extend `set_composition` to forward fps/canvas fields. | Mod |
| `native/src/bin/replay_driver.rs` | Two transition `apply()` arms; extend the `set_composition` arm to read fps/canvas fields into `CompositionPatch`. | Mod |
| `fixtures/state-corpus/sequences/*.json` | ~13 new sequences (7 transition + 6 set_composition). | **New** |
| `fixtures/state-corpus/oracle/*.json` | Regenerated oracle traces (generated). | **New (generated)** |
| `fixtures/state-corpus/README.md` | Transitions + set_composition fps/canvas coverage rows; close gap #3 and the transitions third of gap #6. | Mod |

---

## Task 1: Transitions — TS mutations (`transitions.ts`)

**Files:**
- Create: `src/main/state/mutations/transitions.ts`
- Test: `src/main/state/mutations/transitions.test.ts`

**Interfaces:**
- Produces:
  - `extendLayerTEnd(layer: Layer, deltaUs: number): void` — `t_end_us += delta`; for `VideoClip`/`Audio` also `src_out_us += delta`.
  - `shrinkLayerTEnd(layer: Layer, deltaUs: number): void` — inverse, saturating at 0 (`Math.max(x - delta, 0)`) for `t_end_us` and (VideoClip/Audio) `src_out_us`.
  - `applyAddTransition(p: Project, idGen: IdGen, fromLayer: Uuid, toLayer: Uuid, durationUs: number, kind: Transition['kind']): Uuid` — find `fromLayer`→(track,idx) else `LayerNotFound{layer:fromLayer}`; find `toLayer` ON THE SAME TRACK else `LayerNotFound{layer:toLayer}`; compute `curOverlap = max(fromEnd - toStart, 0)`; if `curOverlap===0 && fromEnd===toStart` extend `fromLayer` by `durationUs`, else if `curOverlap===durationUs` no-op, else throw `TransitionLayersNotAdjacent{from,to,duration}`; THEN `id = idGen()`; push `{id, from_layer, to_layer, duration_us, kind}`; return id.
  - `applyRemoveTransition(p: Project, transitionId: Uuid): void` — find by id else `TransitionNotFound{transition}`; splice it; if its `from_layer` still exists, `shrinkLayerTEnd(fromLayer, tr.duration_us)`.
- Consumes: `applyAddLayer`, `colorParams`, `textParamsDefault` from `./add` (test setup); `CommandFailure` from `../errors`; `seededGen`/`IdGen` from `../ids`; `Layer`, `Transition`, `Project`, `Uuid` from `../model`.

- [ ] **Step 1: Write the failing tests** (`src/main/state/mutations/transitions.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Layer, type Project } from '../model'
import { applyAddLayer, colorParams } from './add'
import { extendLayerTEnd, shrinkLayerTEnd, applyAddTransition, applyRemoveTransition } from './transitions'
import { isCommandFailure } from '../errors'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const CROSSFADE = { kind: 'Crossfade' as const }
const color = () => colorParams(RED, 1920, 1080)

/** Two adjacent color layers on @A: A1=[0,2M], A2=[2M,4M]. Returns gen for id-order asserts. */
function twoAdjacent(): { p: Project; gen: IdGen; a1: string; a2: string } {
  const gen = seededGen()
  const p = blankProject(gen, 't') // #1 A #2 B #3 project
  const a1 = applyAddLayer(p, gen, p.tracks[0].id, color(), 0, 2_000_000) // #4
  const a2 = applyAddLayer(p, gen, p.tracks[0].id, color(), 2_000_000, 4_000_000) // #5
  return { p, gen, a1, a2 }
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}
function layerOf(p: Project, id: string): Layer {
  for (const t of p.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error('layer not found')
}

describe('extendLayerTEnd / shrinkLayerTEnd', () => {
  it('extend color layer touches only t_end_us', () => {
    const l: Layer = layerOf(twoAdjacent().p, twoAdjacent().a1)
    const before = l.t_end_us
    extendLayerTEnd(l, 1_000_000)
    expect(l.t_end_us).toBe(before + 1_000_000)
    expect(l.params.kind).toBe('Color') // no src_out_us on color
  })
  it('extend then shrink a VideoClip touches t_end_us AND src_out_us (saturating at 0)', () => {
    const l: Layer = {
      id: 'x', label: null, t_start_us: 0, t_end_us: 2_000_000, enabled: true, locked: false,
      metadata: {}, effects: [],
      params: { kind: 'VideoClip', media: 'm', src_in_us: 0, src_out_us: 2_000_000,
        transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 },
          scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 },
          rotation_deg: { mode: 'Static', value: 0 }, anchor: [0.5, 0.5] },
        opacity: { mode: 'Static', value: 1 }, crop: null, flip_h: false, flip_v: false,
        blend_mode: 'Normal', speed: 1, fade_in_us: 0, fade_out_us: 0 },
    }
    extendLayerTEnd(l, 500_000)
    expect([l.t_end_us, (l.params as { src_out_us: number }).src_out_us]).toEqual([2_500_000, 2_500_000])
    shrinkLayerTEnd(l, 5_000_000) // over-shrink saturates at 0
    expect([l.t_end_us, (l.params as { src_out_us: number }).src_out_us]).toEqual([0, 0])
  })
})

describe('applyAddTransition', () => {
  it('adjacent layers: extends from_layer and adds the transition (id #6)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE) // #6
    expect(tid).toBe('00000000-0000-0000-0000-000000000006')
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // extended by 1M
    expect(p.transitions).toEqual([{ id: tid, from_layer: a1, to_layer: a2, duration_us: 1_000_000, kind: CROSSFADE }])
  })
  it('already overlapping by exactly duration: no extension, just adds (case 2)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a1).t_end_us = 3_000_000 // hand-position a pre-overlap of 1M (unreachable via the API)
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // unchanged
    expect(p.transitions.map((t) => t.id)).toEqual([tid])
  })
  it('gap or wrong overlap → TransitionLayersNotAdjacent (no id minted)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a2).t_start_us = 3_000_000; layerOf(p, a2).t_end_us = 5_000_000 // gap [2M..3M]
    expectCmd(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE), 'TransitionLayersNotAdjacent')
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6, not #7 → no burn
  })
  it('missing from/to layer → LayerNotFound (no id minted)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    expectCmd(() => applyAddTransition(p, gen, 'ghost', a2, 1_000_000, CROSSFADE), 'LayerNotFound')
    expectCmd(() => applyAddTransition(p, gen, a1, 'ghost', 1_000_000, CROSSFADE), 'LayerNotFound')
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6 → no burn
  })
})

describe('applyRemoveTransition', () => {
  it('shrinks from_layer back and removes the transition', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
    applyRemoveTransition(p, tid)
    expect(layerOf(p, a1).t_end_us).toBe(2_000_000) // shrunk back
    expect(p.transitions).toEqual([])
  })
  it('unknown id → TransitionNotFound', () => {
    const { p } = twoAdjacent()
    expectCmd(() => applyRemoveTransition(p, 'ghost'), 'TransitionNotFound')
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/main/state/mutations/transitions.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`src/main/state/mutations/transitions.ts`):

```ts
import type { Layer, Project, Transition, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'

/** mutations.rs:1412 — extend t_end_us (and src_out_us for media-bearing kinds)
 *  by deltaUs. Used by add_transition to open the authorized overlap. */
export function extendLayerTEnd(layer: Layer, deltaUs: number): void {
  layer.t_end_us += deltaUs
  if (layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio') layer.params.src_out_us += deltaUs
}

/** mutations.rs:1424 — inverse of extendLayerTEnd; saturates at 0. Used by
 *  remove_transition to undo the auto-extension. */
export function shrinkLayerTEnd(layer: Layer, deltaUs: number): void {
  layer.t_end_us = Math.max(layer.t_end_us - deltaUs, 0)
  if (layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio') layer.params.src_out_us = Math.max(layer.params.src_out_us - deltaUs, 0)
}

/** Locate a layer's (trackIdx, layerIdx) or null. */
function locate(p: Project, id: Uuid): [number, number] | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const li = p.tracks[ti].layers.findIndex((l) => l.id === id)
    if (li >= 0) return [ti, li]
  }
  return null
}

/** actor.rs:3200 do_add_transition. Both layers must live on the SAME track.
 *  Three cases: adjacent (extend from), pre-overlapped by exactly duration
 *  (no-op), or reject TransitionLayersNotAdjacent. The transition id is minted
 *  AFTER those checks (so LayerNotFound/TransitionLayersNotAdjacent burn no id)
 *  but BEFORE commit's validate — so a downstream ValidationFailed burns it
 *  (the keystone landmine; gated by add-transition-validate-fail-burns-id). */
export function applyAddTransition(p: Project, idGen: IdGen, fromLayer: Uuid, toLayer: Uuid, durationUs: number, kind: Transition['kind']): Uuid {
  const fromLoc = locate(p, fromLayer)
  if (!fromLoc) throw new CommandFailure({ error: 'LayerNotFound', layer: fromLayer })
  const [trackIdx, fromIdx] = fromLoc
  const toIdx = p.tracks[trackIdx].layers.findIndex((l) => l.id === toLayer)
  if (toIdx < 0) throw new CommandFailure({ error: 'LayerNotFound', layer: toLayer })

  const fromLayerObj = p.tracks[trackIdx].layers[fromIdx]
  const fromEnd = fromLayerObj.t_end_us
  const toStart = p.tracks[trackIdx].layers[toIdx].t_start_us
  const curOverlap = Math.max(fromEnd - toStart, 0)
  if (curOverlap === 0 && fromEnd === toStart) extendLayerTEnd(fromLayerObj, durationUs)
  else if (curOverlap === durationUs) { /* pre-positioned; no adjustment */ }
  else throw new CommandFailure({ error: 'TransitionLayersNotAdjacent', from: fromLayer, to: toLayer, duration: durationUs })

  const id = idGen() // after the checks, before commit's validate (keystone)
  p.transitions.push({ id, from_layer: fromLayer, to_layer: toLayer, duration_us: durationUs, kind })
  return id
}

/** actor.rs:3270 do_remove_transition — remove by id, then shrink from_layer
 *  back by duration (if it still exists) to restore a validation-passing shape. */
export function applyRemoveTransition(p: Project, transitionId: Uuid): void {
  const idx = p.transitions.findIndex((t) => t.id === transitionId)
  if (idx < 0) throw new CommandFailure({ error: 'TransitionNotFound', transition: transitionId })
  const tr = p.transitions[idx]
  p.transitions.splice(idx, 1)
  const loc = locate(p, tr.from_layer)
  if (loc) shrinkLayerTEnd(p.tracks[loc[0]].layers[loc[1]], tr.duration_us)
}
```

- [ ] **Step 4: Run to verify they pass** — `npx vitest run src/main/state/mutations/transitions.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/transitions.ts apps/desktop/src/main/state/mutations/transitions.test.ts
git commit -m "feat(state-migration): transition mutations (Phase 2b-iv)"
```

---

## Task 2: Transitions — dispatch + vocabulary + driver + corpus

**Files:**
- Modify: `src/main/state/actor.ts`, `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`
- Test: `src/main/state/actor.test.ts`, corpus sequences
- Modify: `fixtures/state-corpus/{sequences,oracle}/`

**Interfaces:**
- Consumes: `applyAddTransition`, `applyRemoveTransition` from `./mutations/transitions`; the generalized driver ref-capture (Phase 2b-ii) so `add_transition … "ref":"T1"` is addressable.
- Produces: dispatch handles `add_transition` (returns the new transition id) + `remove_transition`; `SUPPORTED_OPS`/`buildArgs` gain them; the driver gains two arms.

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts` (use the existing test imports `createActor`/`seededGen`/`blankProject`):

```ts
describe('dispatch: transitions', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'tr'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const a1 = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const a2 = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }) as { ok: true; value: string }).value
    return { actor, a1, a2 }
  }
  const fromEnd = (actor: ReturnType<typeof createActor>, id: string) =>
    actor.snapshot().tracks[0].layers.find((l) => l.id === id)!.t_end_us

  it('add_transition extends from_layer + records it; remove_transition shrinks back', () => {
    const { actor, a1, a2 } = setup()
    const t = actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 })
    expect(t.ok).toBe(true)
    const tid = (t as { ok: true; value: string }).value
    expect(fromEnd(actor, a1)).toBe(3_000_000)
    expect(actor.snapshot().transitions.map((x) => x.id)).toEqual([tid])
    expect(actor.dispatch('remove_transition', { transition: tid }).ok).toBe(true)
    expect(fromEnd(actor, a1)).toBe(2_000_000)
    expect(actor.snapshot().transitions).toEqual([])
  })
  it('add_transition with a gap fails TransitionLayersNotAdjacent (no id burned)', () => {
    const { actor, a1 } = setup()
    const far = (actor.dispatch('add_layer', { track: actor.snapshot().tracks[1].id, kind: 'color', t_start_us: 9_000_000, t_end_us: 10_000_000 }) as { ok: true; value: string }).value
    const r = actor.dispatch('add_transition', { from: a1, to: far, duration_us: 1_000_000 })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('LayerNotFound') // far is on a different track → not found on a1's track
  })
  it('remove_transition unknown id → TransitionNotFound', () => {
    const { actor } = setup()
    const r = actor.dispatch('remove_transition', { transition: '00000000-0000-0000-0000-000000000000' })
    expect(r.ok).toBe(false); expect((r as { ok: false; error: { error: string } }).error.error).toBe('TransitionNotFound')
  })
})
```

> Note: the second test deliberately puts `far` on a *different track* — `do_add_transition` only searches `from_layer`'s track for `to_layer`, so a cross-track `to` yields `LayerNotFound`, not `TransitionLayersNotAdjacent`. The same-track gap → `TransitionLayersNotAdjacent` case is gated by the `add-transition-not-adjacent.json` corpus seq in Step 6.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops).

- [ ] **Step 3: Wire `actor.ts`.** Add the import (after the effects import, line 20):
```ts
import { applyAddTransition, applyRemoveTransition } from './mutations/transitions'
```
Add two dispatch arms (after the `remove_effect` arm, ~line 226). The summary string is cosmetic (not gated); use a static label:
```ts
        case 'add_transition': return { ok: true, value: commit('Added transition', [], { kind: 'Coarse' }, (d) => applyAddTransition(d, idGen, a.from as Uuid, a.to as Uuid, a.duration_us as number, { kind: 'Crossfade' })) }
        case 'remove_transition': commit('Removed transition', [], { kind: 'Coarse' }, (d) => applyRemoveTransition(d, a.transition as Uuid)); return { ok: true, value: null }
```

- [ ] **Step 4: Wire `replay.ts`.** Add `'add_transition', 'remove_transition'` to `SUPPORTED_OPS`; add `buildArgs` cases (before the `undo`/`redo` case):
```ts
    case 'add_transition': return { from: resolve(refs, cmd.from), to: resolve(refs, cmd.to), duration_us: cmd.duration_us }
    case 'remove_transition': return { transition: resolve(refs, cmd.transition) }
```

- [ ] **Step 5: Add the 2 driver arms** before the `other =>` arm in `native/src/bin/replay_driver.rs`. Add the import near the existing `use weftcut_lib::state::effect::...` line:
```rust
use weftcut_lib::state::transition::TransitionKind;
```
> If that path does not resolve, `TransitionKind` is also reachable as `weftcut_lib::state::TransitionKind` (re-exported via the `state` module) — try that; the `actor.rs` source imports it as `super::transition::TransitionKind`.

```rust
        "add_transition" => h.add_transition(u, resolve_id(refs, cmd["from"].as_str().unwrap()), resolve_id(refs, cmd["to"].as_str().unwrap()), r(cmd, "duration_us"), TransitionKind::Crossfade).await
            .map(|tid| Some(tid.to_string())).map_err(|e| format!("{e:?}")),
        "remove_transition" => h.remove_transition(u, resolve_id(refs, cmd["transition"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
```

- [ ] **Step 6: Author the corpus sequences** under `fixtures/state-corpus/sequences/`. Every `add_layer` uses `kind: "color"`. Times are on the default 30fps grid.

`add-transition.json`
```json
{ "name": "add-transition", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 4000000, "ref": "L2" },
  { "op": "add_transition", "from": "@L1", "to": "@L2", "duration_us": 1000000, "ref": "T1" }
] }
```
`add-transition-not-adjacent.json` (same-track gap → TransitionLayersNotAdjacent; trailing add_layer gates no-id-burn)
```json
{ "name": "add-transition-not-adjacent", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 3000000, "t_end_us": 5000000, "ref": "L2" },
  { "op": "add_transition", "from": "@L1", "to": "@L2", "duration_us": 1000000 },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L3" }
] }
```
`add-transition-layer-missing.json` (to-layer on a different track → LayerNotFound; trailing add_layer gates no-id-burn)
```json
{ "name": "add-transition-layer-missing", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 2000000, "t_end_us": 4000000, "ref": "L2" },
  { "op": "add_transition", "from": "@L1", "to": "@L2", "duration_us": 1000000 },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 5000000, "t_end_us": 6000000, "ref": "L3" }
] }
```
`add-transition-validate-fail-burns-id.json` (★ keystone: the 2nd add_transition reaches case-2 then validate-fails `LayerInMultipleTransitions`, burning the transition id; the trailing add_layer's id reveals the burn)
```json
{ "name": "add-transition-validate-fail-burns-id", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 4000000, "ref": "L2" },
  { "op": "add_transition", "from": "@L1", "to": "@L2", "duration_us": 1000000, "ref": "T1" },
  { "op": "add_transition", "from": "@L1", "to": "@L2", "duration_us": 1000000 },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L3" }
] }
```
`remove-transition.json`
```json
{ "name": "remove-transition", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 4000000, "ref": "L2" },
  { "op": "add_transition", "from": "@L1", "to": "@L2", "duration_us": 1000000, "ref": "T1" },
  { "op": "remove_transition", "transition": "@T1" }
] }
```
`remove-transition-not-found.json` (double remove → TransitionNotFound; trailing add_layer gates no-op_id-burn)
```json
{ "name": "remove-transition-not-found", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 4000000, "ref": "L2" },
  { "op": "add_transition", "from": "@L1", "to": "@L2", "duration_us": 1000000, "ref": "T1" },
  { "op": "remove_transition", "transition": "@T1" },
  { "op": "remove_transition", "transition": "@T1" },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L3" }
] }
```
`add-transition-undo.json` (undo the recorded transition → from_layer un-extended, transition gone)
```json
{ "name": "add-transition-undo", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 4000000, "ref": "L2" },
  { "op": "add_transition", "from": "@L1", "to": "@L2", "duration_us": 1000000, "ref": "T1" },
  { "op": "undo" }
] }
```

- [ ] **Step 7: Regenerate oracles + run the gate.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the 7 new oracle files as ?? — no M
npx vitest run src/main/state/actor.test.ts src/main/state/__tests__/differential.phase2.test.ts
```
Expected: gate PASS at 110 sequences (103 + 7), `skipped === []`. If a sequence diverges, debug the TS path against the cited Rust; do NOT edit the oracle/gate. The regenerated oracle is the truth.

- [ ] **Step 8: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/add-transition.json apps/desktop/fixtures/state-corpus/sequences/add-transition-not-adjacent.json apps/desktop/fixtures/state-corpus/sequences/add-transition-layer-missing.json apps/desktop/fixtures/state-corpus/sequences/add-transition-validate-fail-burns-id.json apps/desktop/fixtures/state-corpus/sequences/remove-transition.json apps/desktop/fixtures/state-corpus/sequences/remove-transition-not-found.json apps/desktop/fixtures/state-corpus/sequences/add-transition-undo.json apps/desktop/fixtures/state-corpus/oracle/add-transition.json apps/desktop/fixtures/state-corpus/oracle/add-transition-not-adjacent.json apps/desktop/fixtures/state-corpus/oracle/add-transition-layer-missing.json apps/desktop/fixtures/state-corpus/oracle/add-transition-validate-fail-burns-id.json apps/desktop/fixtures/state-corpus/oracle/remove-transition.json apps/desktop/fixtures/state-corpus/oracle/remove-transition-not-found.json apps/desktop/fixtures/state-corpus/oracle/add-transition-undo.json
git commit -m "test(state-migration): transition ops live + corpus (Phase 2b-iv)"
```

---

## Task 3: set_composition-full — canvas-everywhere + faithful rewrite (TS only)

**Files:**
- Modify: `src/main/state/history.ts`, `src/main/state/actor.ts`
- Test: `src/main/state/history.test.ts`, `src/main/state/actor.test.ts`

**Interfaces:**
- Produces:
  - `History.replaceCompositionCanvasEverywhere(canvas: Composition): void` — copy the 7 canvas fields (width/height/fps/sample_rate/channels/color_space/background) from `canvas` into EVERY snapshot + checkpoint; cursor unchanged; not recorded.
  - A rewritten internal `setComposition(patch)` in the actor closure mirroring `do_set_composition` (actor.rs:2929): build the combined probe (canvas + duration + fps re-snap of every layer's `t_start_us`/`t_end_us` + Motif `src_in_us` + duration; then `applyDurationAutofit`), `validate` it once (atomicity); if fps changed → one recorded `commit` of the probe; else → (canvas → `replaceCompositionCanvasEverywhere` + `broadcastUnrecorded`) then (duration → recorded `commit` with autofit).
  - A `runValidate(p: Project): void` helper extracted from `commit` (throws `CommandFailure({error:'ValidationFailed', detail})` on `ValidationFailure`).
- Consumes: `applyDurationAutofit` from `./mutations/helpers`; `snapFrameRound` from `./snap`; `produce` from `immer`; `Composition`/`Rational` types from `./model`.

- [ ] **Step 1: Write the failing History test** in `src/main/state/history.test.ts` (add a describe block; reuse the file's existing `Project`/`blankProject` imports — add `type Composition` to the model import if absent):

```ts
describe('replaceCompositionCanvasEverywhere', () => {
  it('patches the 7 canvas fields into every snapshot, leaving duration + cursor untouched', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h')
    const h = new History(p0, { kind: 'User' }, gen())
    // record a second snapshot that differs (a duration change)
    const p1 = { ...p0, composition: { ...p0.composition, duration_us: 5_000_000, duration_pinned: true } }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 's', affected: [], snapshot: p1 })
    const newCanvas: Composition = { ...p0.composition, width: 1280, height: 720, fps: { num: 24, den: 1 }, background: { r: 10, g: 20, b: 30, a: 255 } }
    h.replaceCompositionCanvasEverywhere(newCanvas)
    // head (p1): canvas patched, duration preserved (canvas-replace copies only the 7 canvas fields)
    expect(h.current().composition.width).toBe(1280)
    expect(h.current().composition.fps).toEqual({ num: 24, den: 1 })
    expect(h.current().composition.duration_us).toBe(5_000_000)
    expect(h.current().composition.duration_pinned).toBe(true)
    // earlier snapshot (Initial) also patched
    const initial = h.undo()!
    expect(initial.composition.width).toBe(1280)
    expect(initial.composition.duration_us).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/history.test.ts` → FAIL (method missing).

- [ ] **Step 3: Implement `replaceCompositionCanvasEverywhere`** in `history.ts` (after `replaceTrackFlagsEverywhere`, before `view`). Add `Composition` to the model import:
```ts
import type { Composition, Project, ProjectSettings, Uuid } from './model'
```
```ts
  /** native/src/state/history.rs:246 — copy the 7 canvas fields (width/height/
   *  fps/sample_rate/channels/color_space/background) into EVERY snapshot +
   *  checkpoint. Composition canvas is preference-shaped, so the change must
   *  survive undo/redo (cursor unchanged; never recorded). duration_us /
   *  duration_pinned are NOT canvas fields and are left untouched. */
  replaceCompositionCanvasEverywhere(canvas: Composition): void {
    const patch = (p: Project): Project => ({
      ...p,
      composition: { ...p.composition,
        width: canvas.width, height: canvas.height, fps: canvas.fps,
        sample_rate: canvas.sample_rate, channels: canvas.channels,
        color_space: canvas.color_space, background: canvas.background },
    })
    for (const e of this.snapshots) e.snapshot = patch(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = patch(cp.snapshot)
  }
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/history.test.ts` → PASS.

- [ ] **Step 5: Add failing actor dispatch tests** to `src/main/state/actor.test.ts`:

```ts
describe('dispatch: set_composition full', () => {
  function withTwoLayers() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 })
    actor.dispatch('add_layer', { track: initial.tracks[1].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    return actor
  }
  it('fps change re-snaps layers + autofits duration (recorded; undoable)', () => {
    const actor = withTwoLayers()
    const before = JSON.stringify(actor.snapshot())
    expect(actor.dispatch('set_composition', { fps: { num: 24, den: 1 } }).ok).toBe(true)
    expect(actor.snapshot().composition.fps).toEqual({ num: 24, den: 1 })
    // unpinned: duration follows the (re-snapped) layer high-water mark
    expect(actor.snapshot().composition.duration_us).toBe(2_000_000)
    expect(actor.dispatch('undo').ok).toBe(true) // recorded → undoable
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })
  it('canvas-only change is unrecorded and survives undo of a prior edit', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc2')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(actor.dispatch('set_composition', { width: 1280, height: 720 }).ok).toBe(true)
    expect(actor.snapshot().composition.width).toBe(1280)
    actor.dispatch('undo') // back to Initial — canvas must persist (replace-everywhere)
    expect(actor.snapshot().composition.width).toBe(1280)
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0)
  })
  it('pins duration on explicit duration write; autofit overflow guard holds', () => {
    const actor = withTwoLayers()
    expect(actor.dispatch('set_composition', { duration_us: 10_000_000 }).ok).toBe(true)
    expect(actor.snapshot().composition.duration_us).toBe(10_000_000)
    expect(actor.snapshot().composition.duration_pinned).toBe(true)
  })
})
```

- [ ] **Step 6: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → the canvas-survives-undo test FAILS (current code broadcasts over `current()` only; `replaceCompositionCanvasEverywhere` not yet wired).

- [ ] **Step 7: Rewrite `setComposition` + extract `runValidate` in `actor.ts`.** Replace the whole `setComposition`/`applyCanvasPatch` block (currently actor.ts:84-128) with the faithful port. First, factor the validate-catch out of `commit` into a `runValidate` helper and have `commit` call it:

```ts
  /** validate(next) → throw CommandFailure(ValidationFailed) on a rule failure.
   *  Shared by commit and set_composition's atomic combined-probe pre-check. */
  function runValidate(next: Project): void {
    try { validate(next) } catch (e) {
      if (e instanceof ValidationFailure) throw new CommandFailure({ error: 'ValidationFailed', detail: e.err })
      throw e
    }
  }
```
In `commit`, replace the inline `try { validate(next) } catch …` block with `runValidate(next)`.

Then the new `setComposition` (mirrors `do_set_composition`, actor.rs:2929-3077). Note `import type { ..., Composition, Rational, ... } from './model'` at the top:

```ts
  // ── set_composition (do_set_composition actor.rs:2929-3077) — atomic combined
  //    probe validate; fps re-snaps every layer + Motif src_in_us + duration; the
  //    non-fps canvas path replaces canvas in EVERY snapshot (survives undo). ──
  function setComposition(patch: Record<string, unknown>): void {
    const cur = current()
    const CANVAS_KEYS = ['width', 'height', 'fps', 'sample_rate', 'channels', 'color_space', 'background']
    const canvasChanges = CANVAS_KEYS.some((k) => patch[k] !== undefined)
    const newFps = (patch.fps as Rational | undefined) ?? cur.composition.fps
    const fpsChanged = patch.fps !== undefined && (newFps.num !== cur.composition.fps.num || newFps.den !== cur.composition.fps.den)
    const durationChange = typeof patch.duration_us === 'number'
      ? snapFrameRound(patch.duration_us, newFps.num, newFps.den) : undefined

    // Build the combined probe (canvas + duration + fps re-snap + autofit).
    const buildProbe = (d: Project): void => {
      applyCanvasFields(d.composition, patch)
      if (durationChange !== undefined) { d.composition.duration_us = durationChange; d.composition.duration_pinned = true }
      if (fpsChanged) {
        const nf = d.composition.fps
        for (const t of d.tracks) for (const l of t.layers) {
          l.t_start_us = snapFrameRound(l.t_start_us, nf.num, nf.den)
          l.t_end_us = snapFrameRound(l.t_end_us, nf.num, nf.den)
          // Motif src_in_us lives on the COMPOSITION grid (re-snap); VideoClip/
          // Audio src_in_us is on the source-PTS grid (left untouched).
          if (l.params.kind === 'Motif') l.params.src_in_us = snapFrameRound(l.params.src_in_us, nf.num, nf.den)
        }
        d.composition.duration_us = snapFrameRound(d.composition.duration_us, nf.num, nf.den)
      }
      applyDurationAutofit(d)
    }

    if (fpsChanged) {
      // Layer geometry changed → one recorded commit of the probe.
      commit('Updated composition fps + re-snapped layers', [], { kind: 'Composition' }, buildProbe)
      return
    }

    // Non-fps: validate the combined probe FIRST (atomicity — never apply canvas
    // everywhere and then fail on the duration commit).
    const probe = produce(cur, buildProbe)
    runValidate(probe)

    if (canvasChanges) {
      const newCanvas = produce(cur.composition, (c: Composition) => applyCanvasFields(c, patch))
      history.replaceCompositionCanvasEverywhere(newCanvas)
      broadcastUnrecorded('Updated composition canvas', current())
    }
    if (durationChange !== undefined) {
      commit('Updated composition duration', [], { kind: 'Composition' }, (d) => {
        d.composition.duration_us = durationChange
        d.composition.duration_pinned = true
        applyDurationAutofit(d)
      })
    }
  }
  /** Copy the present canvas fields of `patch` into a composition draft
   *  (history.rs:391 apply_canvas_fields covers exactly these 7). */
  function applyCanvasFields(c: Composition, patch: Record<string, unknown>): void {
    if (typeof patch.width === 'number') c.width = patch.width
    if (typeof patch.height === 'number') c.height = patch.height
    if (patch.fps) c.fps = patch.fps as Rational
    if (typeof patch.sample_rate === 'number') c.sample_rate = patch.sample_rate
    if (typeof patch.channels === 'number') c.channels = patch.channels
    if (patch.color_space) c.color_space = patch.color_space as Composition['color_space']
    if (patch.background) c.background = patch.background as Project['composition']['background']
  }
```

> The old `setComposition` used `Rgba` in `applyCanvasPatch`; the `Rgba` import at actor.ts:3 may become unused after the rewrite — if `npm run typecheck` flags it, drop `Rgba` from the import. Keep `LayerParams`/`Rgba`/etc. only if still referenced.

- [ ] **Step 8: Run to verify all pass** — `npx vitest run src/main/state/actor.test.ts src/main/state/history.test.ts` → PASS. Then `npx vitest run src/main/state/__tests__/differential.phase2.test.ts` → still 110/110 (the existing `set-composition-duration` oracle is unchanged and must stay byte-identical through the rewrite).

- [ ] **Step 9: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/history.ts apps/desktop/src/main/state/history.test.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts
git commit -m "feat(state-migration): set_composition full (canvas-everywhere + fps re-snap) (Phase 2b-iv)"
```

---

## Task 4: set_composition — driver + buildArgs + corpus

**Files:**
- Modify: `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`
- Modify: `fixtures/state-corpus/{sequences,oracle}/`

**Interfaces:**
- Consumes: the rewritten `setComposition` (Task 3); the driver's `CompositionPatch` (fps/canvas fields already exist in the struct, actor.rs:305).
- Produces: `buildArgs('set_composition')` forwards fps/width/height/sample_rate/channels/color_space/background (in addition to `duration_us`); the driver's `set_composition` arm reads them into `CompositionPatch`.

- [ ] **Step 1: Wire `replay.ts` `buildArgs`.** Replace the `set_composition` case (currently `return { duration_us: cmd.duration_us }`) with the full canvas+fps+duration forward:
```ts
    case 'set_composition': return { duration_us: cmd.duration_us, fps: cmd.fps, width: cmd.width, height: cmd.height, sample_rate: cmd.sample_rate, channels: cmd.channels, color_space: cmd.color_space, background: cmd.background }
```
> The dispatch `setComposition` reads each field with a `typeof`/truthiness guard, so absent (`undefined`) fields are ignored — the existing `set-composition-duration` seq (duration-only) keeps producing the identical state.

- [ ] **Step 2: Extend the driver `set_composition` arm** in `native/src/bin/replay_driver.rs`. Replace the existing arm:
```rust
        "set_composition" => {
            let rat = |v: &Value| -> Option<weftcut_lib::state::time::Rational> {
                v.as_object().map(|o| weftcut_lib::state::time::Rational {
                    num: o["num"].as_i64().unwrap() as i32, den: o["den"].as_i64().unwrap() as i32,
                })
            };
            let patch = CompositionPatch {
                duration_us: cmd["duration_us"].as_i64(),
                fps: cmd.get("fps").filter(|v| !v.is_null()).and_then(|v| rat(v)),
                width: cmd["width"].as_u64().map(|n| n as u32),
                height: cmd["height"].as_u64().map(|n| n as u32),
                sample_rate: cmd["sample_rate"].as_u64().map(|n| n as u32),
                channels: cmd["channels"].as_u64().map(|n| n as u8),
                color_space: cmd.get("color_space").filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()).unwrap()),
                background: cmd.get("background").filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()).unwrap()),
            };
            h.set_composition(u, patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
```
> Confirm the `Rational` field types/path against `native/src/state/time.rs` (the TS model uses `{ num, den }`; Rust `Rational` is likely `{ num: i32, den: i32 }` or `u32` — match the struct exactly; if `num`/`den` are `u32`, use `as u32`). `ColorSpace`/`Rgba` deserialize from the same JSON the TS model emits (`"Bt709"` / `{r,g,b,a}`). If `CompositionPatch` has more `Option` fields than listed, fill the remainder via `..Default::default()`.

- [ ] **Step 3: Author the corpus sequences** under `fixtures/state-corpus/sequences/`. Times are on the 30fps grid; fps targets (24/60) force a visible re-snap.

`set-composition-fps.json` (re-snap two layers; unpinned duration follows re-snapped max_end). L1's `t_end` is `1300000` = exactly 39 frames @30fps (so `add_layer` leaves it untouched) but it is NOT on the 24fps grid, so the fps change MOVES it — this is what makes the seq actually catch a "forgot to re-snap layers" regression (a time like `1000000`/`2000000` lands on both grids and would silently pass a buggy port). The exact post-snap value comes from the regenerated oracle; never hand-encode it.
```json
{ "name": "set-composition-fps", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1300000, "ref": "L1" },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L2" },
  { "op": "set_composition", "fps": { "num": 24, "den": 1 } }
] }
```
`set-composition-fps-and-duration.json` (combined patch: duration snapped to the NEW grid; recorded)
```json
{ "name": "set-composition-fps-and-duration", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "set_composition", "fps": { "num": 24, "den": 1 }, "duration_us": 5000000 }
] }
```
`set-composition-fps-pinned.json` (pin duration, then fps change re-snaps the pinned value; overflow guard)
```json
{ "name": "set-composition-fps-pinned", "commands": [
  { "op": "set_composition", "duration_us": 10000000 },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "set_composition", "fps": { "num": 60, "den": 1 } }
] }
```
`set-composition-canvas.json` (unrecorded canvas; head reflects it; then a normal recorded add)
```json
{ "name": "set-composition-canvas", "commands": [
  { "op": "set_composition", "width": 1280, "height": 720, "background": { "r": 10, "g": 20, "b": 30, "a": 255 } },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" }
] }
```
`set-composition-canvas-survives-undo.json` (★ keystone: canvas replace-everywhere — undo returns to Initial with the canvas still patched)
```json
{ "name": "set-composition-canvas-survives-undo", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "set_composition", "width": 1280, "height": 720 },
  { "op": "undo" }
] }
```
`set-composition-mixed-canvas-duration.json` (non-fps mixed: canvas everywhere + duration commit, in one patch)
```json
{ "name": "set-composition-mixed-canvas-duration", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "set_composition", "width": 1280, "duration_us": 8000000 }
] }
```

- [ ] **Step 4: Regenerate oracles + run the gate.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the 6 new oracle files as ?? — no M (incl. set-composition-duration unchanged)
npx vitest run src/main/state/__tests__/differential.phase2.test.ts
```
Expected: gate PASS at 116 sequences (110 + 6), `skipped === []`. The pre-existing `set-composition-duration.json` oracle MUST remain byte-identical (the driver change is additive — duration-only patches hit the same `CompositionPatch`). If it shows `M`, STOP and investigate.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/replay.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/set-composition-fps.json apps/desktop/fixtures/state-corpus/sequences/set-composition-fps-and-duration.json apps/desktop/fixtures/state-corpus/sequences/set-composition-fps-pinned.json apps/desktop/fixtures/state-corpus/sequences/set-composition-canvas.json apps/desktop/fixtures/state-corpus/sequences/set-composition-canvas-survives-undo.json apps/desktop/fixtures/state-corpus/sequences/set-composition-mixed-canvas-duration.json apps/desktop/fixtures/state-corpus/oracle/set-composition-fps.json apps/desktop/fixtures/state-corpus/oracle/set-composition-fps-and-duration.json apps/desktop/fixtures/state-corpus/oracle/set-composition-fps-pinned.json apps/desktop/fixtures/state-corpus/oracle/set-composition-canvas.json apps/desktop/fixtures/state-corpus/oracle/set-composition-canvas-survives-undo.json apps/desktop/fixtures/state-corpus/oracle/set-composition-mixed-canvas-duration.json
git commit -m "test(state-migration): set_composition fps/canvas live + corpus (Phase 2b-iv)"
```

---

## Task 5: Full suite green + README + whole-branch review + finish

- [ ] **Step 1: Full state suite + typecheck.**
`npx vitest run src/main/state` → all green (capture the count; ~375+ tests). `npm run typecheck` → clean. Confirm the differential gate reports 116 sequences with `skipped === []`.

- [ ] **Step 2: Update the corpus README** (`fixtures/state-corpus/README.md`).
  - **Gap #3** (`set_composition fps/canvas path`): the fps + canvas paths are now gated — delete this gap section (renumber the remaining gaps, or strike its body and mark it closed) and update the DEFERRED table row `set_composition fps/canvas` → remove it.
  - **Gap #6** (`Caption tracks, transitions, params`): strike "transitions" — now covered — leaving "Caption tracks, params". Update the DEFERRED row `Caption tracks / transitions / params` → `Caption tracks / params`.
  - Add two new coverage sections after the effects block:
    ```markdown
    | **— transitions (same-track authorized overlap) —** | |
    | add_transition adjacent (auto-extend from_layer) | add-transition.json |
    | add_transition same-track gap → TransitionLayersNotAdjacent | add-transition-not-adjacent.json |
    | add_transition cross-track to-layer → LayerNotFound | add-transition-layer-missing.json |
    | add_transition validate-fail (2nd on same from) burns the transition id | add-transition-validate-fail-burns-id.json |
    | remove_transition (shrinks from_layer back) | remove-transition.json |
    | remove_transition → TransitionNotFound (double remove) | remove-transition-not-found.json |
    | add_transition undo (un-extends + drops the transition) | add-transition-undo.json |
    | **— set_composition fps + canvas —** | |
    | set_composition fps re-snap (unpinned autofit) | set-composition-fps.json |
    | set_composition fps + duration (snapped to new grid) | set-composition-fps-and-duration.json |
    | set_composition fps re-snap (pinned + overflow guard) | set-composition-fps-pinned.json |
    | set_composition canvas (unrecorded) | set-composition-canvas.json |
    | set_composition canvas survives undo (replace-everywhere) | set-composition-canvas-survives-undo.json |
    | set_composition mixed canvas + duration | set-composition-mixed-canvas-duration.json |
    ```

- [ ] **Step 3: Commit the README.**
```bash
git add apps/desktop/fixtures/state-corpus/README.md
git commit -m "docs(state-migration): corpus README — Phase 2b-iv transitions + set_composition coverage"
```

- [ ] **Step 4: Whole-branch code review** (superpowers:requesting-code-review). Scope: the Phase-2b-iv commits. Focus: (a) `applyAddTransition` mints the id AFTER the layer + adjacency checks but BEFORE commit — so `LayerNotFound`/`TransitionLayersNotAdjacent` burn no id while a `ValidationFailed` burns the transition id (verified by `add-transition-validate-fail-burns-id` + the not-adjacent/layer-missing no-burn seqs + the unit test); (b) `applyRemoveTransition` shrinks `from_layer` back (saturating) only if it still exists; (c) the `set_composition` rewrite mirrors `do_set_composition` — atomic combined-probe validate, fps re-snap of every layer's t_start/t_end + Motif src_in_us + duration, `applyDurationAutofit`, canvas replace-everywhere (survives undo), one recorded commit on the fps path; (d) the driver + buildArgs changes are purely ADDITIVE (103 pre-existing oracles byte-identical via regen, incl. `set-composition-duration`); (e) gate integrity preserved (`skipped === []`, every new oracle byte-identical).

- [ ] **Step 5:** superpowers:finishing-a-development-branch — confirm the integration choice (this work sits on local `main`; per Phase 0/1/2a/2b-i/2b-ii/2b-iii, default keep-local/unpushed unless the user says otherwise).

---

## Self-Review (author checklist — completed)

- **Spec coverage:** transitions add (Tasks 1-2, incl. auto-extend) + remove (Tasks 1-2, incl. shrink-back) + the validate-fail id-burn keystone (corpus + unit) + undo; `set_composition` fps re-snap (Tasks 3-4, layers + Motif + duration + autofit), canvas replace-everywhere incl. undo-survival (Tasks 3-4), pinned/overflow + mixed (Task 4). Closes README gap #3 and the transitions third of gap #6. ✓
- **Placeholder scan:** every step has concrete code/commands/expected output. ✓
- **Type consistency:** `extendLayerTEnd`/`shrinkLayerTEnd`/`applyAddTransition`/`applyRemoveTransition` named identically across Task 1 (producer) and Task 2 (dispatch imports); `replaceCompositionCanvasEverywhere`/`runValidate`/`applyCanvasFields` consistent across Task 3; dispatch arg shapes (`from`/`to`/`duration_us`/`transition`; `fps`/`width`/`height`/`duration_us`/…) consistent between `buildArgs`, the dispatch arms, and the driver; error variants (`LayerNotFound`/`TransitionNotFound`/`TransitionLayersNotAdjacent`) pre-exist in `errors.ts`. ✓
- **Landmines captured:** the `add_transition` id-mint-after-checks-before-commit asymmetry (THIRD burn pattern — Global Constraints + Task-1 comment + Task-1 unit test + the `add-transition-validate-fail-burns-id` corpus gate + the two no-burn seqs); the current `setComposition` canvas bug (broadcast over `current()` never updates stored snapshots, breaks undo) fixed by `replaceCompositionCanvasEverywhere` (gated by `set-composition-canvas-survives-undo`); atomic combined-probe validate (non-fps mixed canvas+duration); fps re-snap covers Motif `src_in_us` (ungated — no Motif in the corpus — but faithful to Rust); additive-driver-change (103 oracles byte-identical incl. `set-composition-duration`); gate-ordering invariant (Tasks 1+3 ship no corpus; corpus follows BOTH-side wiring in Tasks 2+4); cross-track `to_layer` → `LayerNotFound` (not `TransitionLayersNotAdjacent`). ✓
- **Ungated-by-corpus paths covered by unit tests:** `extendLayerTEnd`/`shrinkLayerTEnd` `src_out_us` branch (VideoClip; no media in corpus — unit-tested); `applyAddTransition` case-2 pre-overlap (unreachable via the public API since validate rejects the setup — unit-tested on a hand-positioned project); `History.replaceCompositionCanvasEverywhere` (unit-tested directly). ✓
