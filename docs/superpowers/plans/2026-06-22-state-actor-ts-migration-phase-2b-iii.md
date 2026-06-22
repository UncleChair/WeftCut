# State-Actor TS Migration — Phase 2b-iii Plan (per-layer effects)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the THIRD slice of **Phase 2b** of the master plan `2026-06-22-state-actor-ts-migration.md`. Read the **Phase-2b-ii plan** (`…-phase-2b-ii.md`) first — it generalized the Rust driver's ref-capture (the keystone this slice depends on) and established the per-slice workflow (extend driver → author corpus → regen oracles → port TS → extend dispatch+vocab → differential-gate). This slice ports the per-layer **effect chain** ops.

**Goal:** Port and differential-gate the four per-layer effect mutations — `add_effect`, `update_effect`, `move_effect`, `remove_effect` — so a layer's ordered effect chain is fully maintained by the TS actor, byte-identical to the Rust oracle.

**Architecture:** Same as Phase 1/2a/2b-i/2b-ii — pure functions over an Immer draft, 1:1 with Rust `apply_*_effect`; the actor's `commit` runs validate→record→emit. All four ops are RECORDED (undoable) and go through the generic `commit` pipeline — no dedicated actor paths this slice. The one non-obvious rule is the **`add_effect` id-allocation asymmetry**: unlike `add_layer` (which mints the entity id only AFTER the track-existence check), `add_effect` mints the effect id UNCONDITIONALLY before the layer lookup, so a `LayerNotFound` still burns the id and shifts every later id. The differential corpus grows by 9 sequences; the Rust `replay_driver` gains four arms; the TS gate (`differential.phase2.test.ts`) auto-picks-up new sequences once vocabulary + oracles exist.

**Tech Stack:** TypeScript, Immer, Vitest, the `weftcut-eval` wasm leaf (`snapFrameRound`, UNCHANGED), the Rust `replay_driver` bin + `gen-state-oracle.mjs` (needs the cargo/ffmpeg toolchain).

## Global Constraints

- **The oracle-regeneration toolchain (verified working 2026-06-22).** Regenerating oracles builds `replay_driver` (compiles the native crate incl. ffmpeg-next). Set these env vars before any `cargo`/regen, then run from `apps/desktop/`:
  ```bash
  export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
  export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
  export PATH="$FFMPEG_DIR/bin:$PATH"
  node scripts/gen-state-oracle.mjs   # builds replay_driver, runs each sequence 2× (determinism gate), writes oracle/*.json
  ```
  The build feature set is baked into `gen-state-oracle.mjs` (`--features replay,jobs,export,mcp,cloud,motifs`; bare `replay` fails on a pre-existing `napi_backend.rs` error). **Every driver change in this slice is ADDITIVE** — after a regen, the **94 pre-existing oracles must be byte-identical**; only NEW oracle files may appear. Verify with `git status --short fixtures/state-corpus/oracle/` after each regen (only `??` new files, never `M`). If an existing oracle shows Modified, STOP — the change wasn't additive; investigate.
- **Baseline:** the corpus currently holds **94 sequences / 94 oracles**; `differential.phase2.test.ts` runs all 94 with `skipped === []`.
- **Gate-ordering invariant (why task order matters).** `differential.phase2.test.ts` asserts `skipped === []` over the LIVE corpus dir, and `gen-state-oracle.mjs` runs the Rust driver over the LIVE corpus dir. So for any new op X: X must be in TS `SUPPORTED_OPS` + `buildArgs` + a dispatch arm + its mutation, AND in the Rust driver's `apply()`, **before** any corpus sequence using X exists. Never add a corpus sequence whose op isn't already supported on BOTH sides. (Task 1 lands the TS mutations + unit tests with NO corpus; Task 2 wires dispatch+vocab+driver and only THEN authors the corpus.)
- **★ KEYSTONE LANDMINE — `add_effect` mints the effect id UNCONDITIONALLY, before the layer lookup.** `commands::mutations::add_effect` (mutations.rs:460-474) calls `crate::state::ids::new_id()` to build the `Effect` **before** the handle call; `apply_add_effect` (mutations.rs:1462) then takes `let id = effect.id` and only afterward searches for the layer, returning `LayerNotFound` if absent. So an `add_effect` on a missing layer **still burns the effect id**. This is the OPPOSITE of `add_layer`, whose `apply_add_layer` (mutations.rs:62) mints `new_id()` only AFTER the `TrackNotFound` check. Because op-ids and entity-ids share one deterministic counter, getting this wrong (minting after the lookup) drifts every later id. The TS `applyAddEffect` MUST mint `idGen()` at the very top, unconditionally, before searching tracks. Gated by `add-effect-missing-layer-burns-id.json` (a later `add_layer` whose id reveals the burn) AND a `mutations/effects.test.ts` unit test.
- **id contract (otherwise unchanged):** `commit` allocates the op_id AFTER `validate`; a successful recorded op burns one op_id; a failed mutation or failed validate burns no op_id (the throw inside the `produce` recipe aborts `commit` before `idGen()` is called for the op). `add_effect` additionally burns one entity id (the effect id) whether or not it succeeds, per the keystone landmine above. `update_effect`/`move_effect`/`remove_effect` mint NO entity id.
- **`update_effect` patch semantics** (`EffectPatch` effect.rs:29-33; `apply_update_effect` mutations.rs:1482-1508): `enabled` (when present) REPLACES the flag; `params` (when present) is MERGED key-by-key into the effect's params map (insert/overwrite per key, **no deletions**). Absent/`null` fields are "don't touch". Param values are `Animated<f64>` in the `{ "mode": "Static", "value": N }` / `{ "mode": "Keyframed", "value": [...] }` wire shape (animated.rs:30-35 `#[serde(tag="mode", content="value")]`, matching the TS `Animated<number>` union in model.ts:20).
- **`move_effect` index semantics** (`apply_move_effect` mutations.rs:1513-1537): rejection order is `LayerNotFound` (layer absent) → `EffectNotFound` (effect absent) → `EffectIndexOutOfRange` (`new_index >= len`); on success, remove-then-insert at `new_index` (0 = first/topmost). `EffectNotFound` is checked BEFORE the index bound.
- **`remove_effect`** (`apply_remove_effect` mutations.rs:1541-1558): `LayerNotFound` → `EffectNotFound` (effect absent) → splice it out.
- **All four ops record under `EntityRef::Layer(layer_id)` with `DiffHint::Coarse`** (do_*_effect actor.rs:2811-2883). The differential trace compares only `state` / `ok` / `error` — NOT the change summary, affected refs, op_id, or diff hint — so the summary strings are cosmetic (mirror Rust's for cleanliness, but they are not gated).
- **`CommandError` variant names match Rust** — `LayerNotFound`, `EffectNotFound`, `EffectIndexOutOfRange` — all already in `errors.ts:29,55,56`. No `errors.ts` change needed.
- **The wasm snap leaf is sacred** — never reimplemented. **TimeUs is `number`.**
- **`mutations/effects.ts` is NEW** but the data types already exist: `Effect { id, kind, enabled, params }` and `Layer.effects: Effect[]` are in model.ts:65-69; new layers already initialize `effects: []` (add.ts:34). `serializeProject` is identity over `effects` (serialize.ts) and `canonicalize` recursively sorts the `params` object keys (matching the Rust `BTreeMap`), so no serde/canonical work is required.
- Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `git add` by **explicit path only** (parallel sessions — [[feedback_parallel_sessions_git]]). Work on local `main`; do NOT push. TDD, frequent commits, DRY, YAGNI.

### Reference Rust sources (cite; re-read only if a differential step diverges)

- Data model: `native/src/state/effect.rs` (`Effect`, `EffectPatch`); `Animated<f64>` wire shape `native/src/state/animated.rs:30-35`.
- Mutation helpers: `apply_add_effect`/`apply_update_effect`/`apply_move_effect`/`apply_remove_effect` — `native/src/state/actor/mutations.rs:1462-1558`.
- Actor `do_*` (commit wrapping): `native/src/state/actor.rs:2811-2883` (all four use `EntityRef::Layer(layer_id)`, `DiffHint::Coarse`).
- Handles: `add_effect`/`update_effect`/`move_effect`/`remove_effect` — `native/src/state/actor.rs:1286-1341`.
- Production command surface (the id-mint asymmetry): `commands::mutations::add_effect` — `native/src/commands/mutations.rs:460-474` (mints `new_id()` before the handle; effect starts `enabled:true`, `params: empty`).
- TS pieces already in place: `Effect`/`Layer.effects` (`src/main/state/model.ts:65,69`); error variants (`src/main/state/errors.ts:29,55,56`); the `commit`/dispatch idiom (`src/main/state/actor.ts:191-228`); the existing `applyAddLayer` id-after-check contrast (`src/main/state/mutations/add.ts:28-40`).

---

## File Structure

All paths under `apps/desktop/`. Vitest from `apps/desktop/` (`npx vitest run <path>`).

| Path | Responsibility | New/Mod |
|---|---|---|
| `src/main/state/mutations/effects.ts` | `EffectPatch` type; `applyAddEffect` (unconditional id-mint), `applyUpdateEffect` (param merge), `applyMoveEffect` (index reorder), `applyRemoveEffect`. | **New** |
| `src/main/state/mutations/effects.test.ts` | Unit tests incl. the id-burn-on-LayerNotFound landmine. | **New** |
| `src/main/state/actor.ts` | Import + four dispatch arms (`add_effect` returns the new id; the rest return null). | Mod |
| `src/main/state/replay.ts` | `SUPPORTED_OPS` + `buildArgs` for the four ops. | Mod |
| `src/main/state/actor.test.ts` | Add an effects dispatch describe block. | Mod |
| `native/src/bin/replay_driver.rs` | Four `apply()` arms; `add_effect` mints `new_id()` before the handle. | Mod |
| `fixtures/state-corpus/sequences/*.json` | 9 new sequences. | **New** |
| `fixtures/state-corpus/oracle/*.json` | Regenerated oracle traces (generated). | **New (generated)** |
| `fixtures/state-corpus/README.md` | Effects coverage rows; close gap #6 (effects half). | Mod |

---

## Task 1: Effects — TS mutations (`effects.ts`)

**Files:**
- Create: `src/main/state/mutations/effects.ts`
- Test: `src/main/state/mutations/effects.test.ts`

**Interfaces:**
- Produces:
  - `EffectPatch` — `{ enabled?: boolean | null; params?: Record<string, Animated<number>> | null }`.
  - `applyAddEffect(p: Project, idGen: IdGen, layerId: Uuid, kind: string): Uuid` — mints the effect id UNCONDITIONALLY (before the layer lookup), appends `{ id, kind, enabled: true, params: {} }`, returns the id; throws `LayerNotFound` (after the id is already minted).
  - `applyUpdateEffect(p: Project, layerId: Uuid, effectId: Uuid, patch: EffectPatch): void` — `LayerNotFound` → `EffectNotFound`; replaces `enabled` when present; merges `params` key-by-key when present.
  - `applyMoveEffect(p: Project, layerId: Uuid, effectId: Uuid, newIndex: number): void` — `LayerNotFound` → `EffectNotFound` → `EffectIndexOutOfRange`; remove-then-insert.
  - `applyRemoveEffect(p: Project, layerId: Uuid, effectId: Uuid): void` — `LayerNotFound` → `EffectNotFound`; splice.
- Consumes: `applyAddLayer`, `applyAddTrack`, `colorParams` from `./add` (test setup); `CommandFailure` from `../errors`; `seededGen`/`IdGen` from `../ids`; `Effect`, `Animated`, `Project`, `Uuid` from `../model`.

- [ ] **Step 1: Write the failing tests** (`src/main/state/mutations/effects.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddLayer, applyAddTrack, colorParams } from './add'
import { applyAddEffect, applyUpdateEffect, applyMoveEffect, applyRemoveEffect } from './effects'
import { isCommandFailure } from '../errors'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const sp = (v: number) => ({ mode: 'Static' as const, value: v })

/** Fresh project with one color layer on @A. `gen` is returned so tests can
 *  assert id-allocation order. */
function withLayer(): { p: Project; gen: IdGen; layerId: string } {
  const gen = seededGen()
  const p = blankProject(gen, 't') // ids #1 (A) #2 (B) #3 (project)
  const layerId = applyAddLayer(p, gen, p.tracks[0].id, colorParams(RED, 1920, 1080), 0, 1_000_000) // #4
  return { p, gen, layerId }
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}
function effectsOf(p: Project, layerId: string) {
  for (const t of p.tracks) { const l = t.layers.find((x) => x.id === layerId); if (l) return l.effects }
  throw new Error('layer not found')
}

describe('applyAddEffect', () => {
  it('appends an effect with enabled:true and empty params; returns its id', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur') // #5
    expect(eid).toBe('00000000-0000-0000-0000-000000000005')
    const fx = effectsOf(p, layerId)
    expect(fx).toHaveLength(1)
    expect(fx[0]).toEqual({ id: eid, kind: 'blur', enabled: true, params: {} })
  })
  it('preserves append order across multiple adds', () => {
    const { p, gen, layerId } = withLayer()
    const e1 = applyAddEffect(p, gen, layerId, 'blur')
    const e2 = applyAddEffect(p, gen, layerId, 'brightness')
    expect(effectsOf(p, layerId).map((e) => e.id)).toEqual([e1, e2])
  })
  // ★ KEYSTONE: the id is minted BEFORE the layer lookup, so a LayerNotFound
  //   still burns it (unlike applyAddLayer, which mints after the track check).
  it('mints (burns) the effect id even when the layer is missing', () => {
    const { p, gen } = withLayer() // next idGen() would be #5
    expectCmd(() => applyAddEffect(p, gen, 'ghost', 'blur'), 'LayerNotFound')
    // #5 was burned by the failed add_effect; the next mint is #6.
    expect(applyAddTrack(p, gen, 'x')).toBe('00000000-0000-0000-0000-000000000006')
  })
})

describe('applyUpdateEffect', () => {
  it('replaces enabled when present', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { enabled: false })
    expect(effectsOf(p, layerId)[0].enabled).toBe(false)
  })
  it('merges params key-by-key (insert + overwrite, no deletion)', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { params: { radius: sp(8), sigma: sp(2) } })
    applyUpdateEffect(p, layerId, eid, { params: { radius: sp(12) } }) // overwrite radius, keep sigma
    expect(effectsOf(p, layerId)[0].params).toEqual({ radius: sp(12), sigma: sp(2) })
  })
  it('null/absent fields are "do not touch"', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyUpdateEffect(p, layerId, eid, { enabled: null, params: null })
    expect(effectsOf(p, layerId)[0]).toEqual({ id: eid, kind: 'blur', enabled: true, params: {} })
  })
  it('throws LayerNotFound / EffectNotFound', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    expectCmd(() => applyUpdateEffect(p, 'ghost', eid, { enabled: false }), 'LayerNotFound')
    expectCmd(() => applyUpdateEffect(p, layerId, 'ghost', { enabled: false }), 'EffectNotFound')
  })
})

describe('applyMoveEffect', () => {
  it('reorders an effect to a new index (0 = first)', () => {
    const { p, gen, layerId } = withLayer()
    const e1 = applyAddEffect(p, gen, layerId, 'blur')
    const e2 = applyAddEffect(p, gen, layerId, 'brightness')
    applyMoveEffect(p, layerId, e2, 0)
    expect(effectsOf(p, layerId).map((e) => e.id)).toEqual([e2, e1])
  })
  it('rejection order: EffectNotFound before EffectIndexOutOfRange', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    expectCmd(() => applyMoveEffect(p, layerId, 'ghost', 9), 'EffectNotFound')
    expectCmd(() => applyMoveEffect(p, layerId, eid, 9), 'EffectIndexOutOfRange')
    expectCmd(() => applyMoveEffect(p, 'ghost', eid, 0), 'LayerNotFound')
  })
})

describe('applyRemoveEffect', () => {
  it('removes an effect by id', () => {
    const { p, gen, layerId } = withLayer()
    const e1 = applyAddEffect(p, gen, layerId, 'blur')
    const e2 = applyAddEffect(p, gen, layerId, 'brightness')
    applyRemoveEffect(p, layerId, e1)
    expect(effectsOf(p, layerId).map((e) => e.id)).toEqual([e2])
  })
  it('throws LayerNotFound / EffectNotFound', () => {
    const { p, gen, layerId } = withLayer()
    const eid = applyAddEffect(p, gen, layerId, 'blur')
    applyRemoveEffect(p, layerId, eid)
    expectCmd(() => applyRemoveEffect(p, layerId, eid), 'EffectNotFound')
    expectCmd(() => applyRemoveEffect(p, 'ghost', eid), 'LayerNotFound')
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/main/state/mutations/effects.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`src/main/state/mutations/effects.ts`):

```ts
import type { Animated, Effect, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'

/** Mirrors native/src/state/effect.rs:29-33 EffectPatch. Absent/null = "don't
 *  touch"; `params` MERGES key-by-key (insert/overwrite, no deletion). */
export interface EffectPatch {
  enabled?: boolean | null
  params?: Record<string, Animated<number>> | null
}

/** Locate the layer's effect chain or throw LayerNotFound. */
function effectsOrThrow(p: Project, layerId: Uuid): Effect[] {
  for (const track of p.tracks) {
    const l = track.layers.find((x) => x.id === layerId)
    if (l) return l.effects
  }
  throw new CommandFailure({ error: 'LayerNotFound', layer: layerId })
}

/** mutations.rs:1462 (apply_add_effect) + commands/mutations.rs:460-474. The
 *  effect id is minted UNCONDITIONALLY, BEFORE the layer lookup — so a
 *  LayerNotFound still burns the id. This is the OPPOSITE of applyAddLayer
 *  (add.ts:33, mints after the track check). Mints here, not in the dispatch
 *  arm, so the actor's commit pipeline stays uniform. */
export function applyAddEffect(p: Project, idGen: IdGen, layerId: Uuid, kind: string): Uuid {
  const id = idGen() // unconditional — burned even on LayerNotFound
  const effect: Effect = { id, kind, enabled: true, params: {} }
  effectsOrThrow(p, layerId).push(effect)
  return id
}

/** mutations.rs:1482 — replace `enabled` when present; merge `params`
 *  key-by-key when present. LayerNotFound → EffectNotFound. */
export function applyUpdateEffect(p: Project, layerId: Uuid, effectId: Uuid, patch: EffectPatch): void {
  const e = effectsOrThrow(p, layerId).find((x) => x.id === effectId)
  if (!e) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  if (typeof patch.enabled === 'boolean') e.enabled = patch.enabled
  if (patch.params && typeof patch.params === 'object') {
    for (const [k, v] of Object.entries(patch.params)) e.params[k] = v
  }
}

/** mutations.rs:1513 — reorder within the chain (0 = first). Rejection order:
 *  LayerNotFound → EffectNotFound → EffectIndexOutOfRange (>= len). */
export function applyMoveEffect(p: Project, layerId: Uuid, effectId: Uuid, newIndex: number): void {
  const effects = effectsOrThrow(p, layerId)
  const from = effects.findIndex((e) => e.id === effectId)
  if (from < 0) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  const len = effects.length
  if (newIndex >= len) throw new CommandFailure({ error: 'EffectIndexOutOfRange', index: newIndex, len })
  const [e] = effects.splice(from, 1)
  effects.splice(newIndex, 0, e)
}

/** mutations.rs:1541 — remove by id. LayerNotFound → EffectNotFound. */
export function applyRemoveEffect(p: Project, layerId: Uuid, effectId: Uuid): void {
  const effects = effectsOrThrow(p, layerId)
  const at = effects.findIndex((e) => e.id === effectId)
  if (at < 0) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  effects.splice(at, 1)
}
```

- [ ] **Step 4: Run to verify they pass** — `npx vitest run src/main/state/mutations/effects.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/effects.ts apps/desktop/src/main/state/mutations/effects.test.ts
git commit -m "feat(state-migration): per-layer effect mutations (Phase 2b-iii)"
```

---

## Task 2: Effects — dispatch + vocabulary + driver + corpus

**Files:**
- Modify: `src/main/state/actor.ts`, `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`
- Test: `src/main/state/actor.test.ts`, corpus sequences
- Modify: `fixtures/state-corpus/{sequences,oracle}/`

**Interfaces:**
- Consumes: `applyAddEffect`, `applyUpdateEffect`, `applyMoveEffect`, `applyRemoveEffect`, `EffectPatch` from `./mutations/effects`; the generalized driver ref-capture (Phase 2b-ii) so `add_effect … "ref":"E1"` is addressable.
- Produces: dispatch handles the four effect ops; `SUPPORTED_OPS`/`buildArgs` gain them; driver gains four arms (`add_effect` mints `new_id()` before the handle).

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts`:

```ts
describe('dispatch: effect chain', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'fx'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    return { actor, l }
  }
  const fx = (actor: ReturnType<typeof createActor>, l: string) =>
    actor.snapshot().tracks[0].layers.find((x) => x.id === l)!.effects

  it('add → update(enabled) → move → remove', () => {
    const { actor, l } = setup()
    const e1 = (actor.dispatch('add_effect', { layer: l, kind: 'blur' }) as { ok: true; value: string }).value
    const e2 = (actor.dispatch('add_effect', { layer: l, kind: 'brightness' }) as { ok: true; value: string }).value
    expect(fx(actor, l).map((e) => e.id)).toEqual([e1, e2])
    expect(actor.dispatch('update_effect', { layer: l, effect: e1, patch: { enabled: false } }).ok).toBe(true)
    expect(fx(actor, l)[0].enabled).toBe(false)
    expect(actor.dispatch('move_effect', { layer: l, effect: e2, new_index: 0 }).ok).toBe(true)
    expect(fx(actor, l).map((e) => e.id)).toEqual([e2, e1])
    expect(actor.dispatch('remove_effect', { layer: l, effect: e1 }).ok).toBe(true)
    expect(fx(actor, l).map((e) => e.id)).toEqual([e2])
  })
  it('add_effect on a missing layer fails LayerNotFound but burns the id', () => {
    const { actor, l } = setup()
    const r = actor.dispatch('add_effect', { layer: '00000000-0000-0000-0000-000000000000', kind: 'blur' })
    expect(r.ok).toBe(false); expect((r as { ok: false; error: { error: string } }).error.error).toBe('LayerNotFound')
    // the burned id shifts the next add_effect's id forward by one.
    const eAfter = (actor.dispatch('add_effect', { layer: l, kind: 'blur' }) as { ok: true; value: string }).value
    expect(fx(actor, l)).toHaveLength(1); expect(fx(actor, l)[0].id).toBe(eAfter)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops).

- [ ] **Step 3: Wire `actor.ts`.** Add the import (after the tracks import, line 19) and four dispatch arms (after the `update_track_flags` arm, line 221):

```ts
import { applyAddEffect, applyUpdateEffect, applyMoveEffect, applyRemoveEffect, type EffectPatch } from './mutations/effects'
```
```ts
        case 'add_effect': return { ok: true, value: commit('Added effect', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyAddEffect(d, idGen, a.layer as Uuid, a.kind as string)) }
        case 'update_effect': commit('Updated effect', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyUpdateEffect(d, a.layer as Uuid, a.effect as Uuid, a.patch as EffectPatch)); return { ok: true, value: null }
        case 'move_effect': commit('Reordered effect', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyMoveEffect(d, a.layer as Uuid, a.effect as Uuid, a.new_index as number)); return { ok: true, value: null }
        case 'remove_effect': commit('Removed effect', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyRemoveEffect(d, a.layer as Uuid, a.effect as Uuid)); return { ok: true, value: null }
```

- [ ] **Step 4: Wire `replay.ts`.** Add `'add_effect', 'update_effect', 'move_effect', 'remove_effect'` to `SUPPORTED_OPS`; add `buildArgs` cases (before the `undo`/`redo` case):

```ts
    case 'add_effect': return { layer: resolve(refs, cmd.layer), kind: cmd.kind }
    case 'update_effect': return { layer: resolve(refs, cmd.layer), effect: resolve(refs, cmd.effect), patch: { enabled: cmd.enabled, params: cmd.params } }
    case 'move_effect': return { layer: resolve(refs, cmd.layer), effect: resolve(refs, cmd.effect), new_index: cmd.new_index }
    case 'remove_effect': return { layer: resolve(refs, cmd.layer), effect: resolve(refs, cmd.effect) }
```

- [ ] **Step 5: Add the 4 driver arms** before the `other =>` arm in `native/src/bin/replay_driver.rs`. Extend the top imports to include the effect types + `BTreeMap`:

```rust
use std::collections::{BTreeMap, HashMap};
use weftcut_lib::state::effect::{Effect, EffectPatch};
```
(`HashMap` is already imported on the existing `use std::collections::HashMap;` line — replace it with the combined `BTreeMap, HashMap` import; `Animated` is already in scope.)

```rust
        "add_effect" => {
            // commands/mutations.rs:460-474: mint the effect id UNCONDITIONALLY,
            // before the handle — a LayerNotFound still burns it.
            let effect = Effect {
                id: weftcut_lib::state::ids::new_id(),
                kind: cmd["kind"].as_str().unwrap().to_string(),
                enabled: true,
                params: BTreeMap::new(),
            };
            h.add_effect(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), effect).await
                .map(|eid| Some(eid.to_string())).map_err(|e| format!("{e:?}"))
        }
        "update_effect" => {
            let params = cmd.get("params").filter(|v| !v.is_null())
                .map(|v| serde_json::from_value::<BTreeMap<String, Animated<f64>>>(v.clone()).unwrap());
            let patch = EffectPatch { enabled: cmd["enabled"].as_bool(), params };
            h.update_effect(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), resolve_id(refs, cmd["effect"].as_str().unwrap()), patch).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "move_effect" => h.move_effect(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), resolve_id(refs, cmd["effect"].as_str().unwrap()), cmd["new_index"].as_u64().unwrap() as usize).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "remove_effect" => h.remove_effect(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), resolve_id(refs, cmd["effect"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
```

> If `weftcut_lib::state::ids::new_id` is not re-exported at that path, fall back to the path `commands::mutations::add_effect` uses — `crate::state::ids::new_id` is `weftcut_lib::state::ids::new_id` from the bin (the `ids` module is already reachable via the existing `use weftcut_lib::state::ids::det;`). If neither resolves, add a `use weftcut_lib::state::ids::new_id;` import and call it bare.

- [ ] **Step 6: Author the corpus sequences** under `fixtures/state-corpus/sequences/` (effect ids addressable via the generalized ref-capture). Every `add_layer` uses `kind: "color"`.

`add-effect.json`
```json
{ "name": "add-effect", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" }
] }
```
`update-effect-enabled.json`
```json
{ "name": "update-effect-enabled", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" },
  { "op": "update_effect", "layer": "@L1", "effect": "@E1", "enabled": false }
] }
```
`update-effect-params.json`
```json
{ "name": "update-effect-params", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" },
  { "op": "update_effect", "layer": "@L1", "effect": "@E1", "params": { "radius": { "mode": "Static", "value": 8 }, "sigma": { "mode": "Static", "value": 2 } } },
  { "op": "update_effect", "layer": "@L1", "effect": "@E1", "params": { "radius": { "mode": "Static", "value": 12 } } }
] }
```
`update-effect-not-found.json` (remove then update the same id → EffectNotFound; trailing add_layer gates "no op_id burned on failure")
```json
{ "name": "update-effect-not-found", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" },
  { "op": "remove_effect", "layer": "@L1", "effect": "@E1" },
  { "op": "update_effect", "layer": "@L1", "effect": "@E1", "enabled": false },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" }
] }
```
`move-effect-reorder.json`
```json
{ "name": "move-effect-reorder", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" },
  { "op": "add_effect", "layer": "@L1", "kind": "brightness", "ref": "E2" },
  { "op": "move_effect", "layer": "@L1", "effect": "@E2", "new_index": 0 }
] }
```
`move-effect-out-of-range.json` (EffectNotFound checked before the index bound — and EffectIndexOutOfRange on a real effect)
```json
{ "name": "move-effect-out-of-range", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" },
  { "op": "move_effect", "layer": "@L1", "effect": "@E1", "new_index": 5 }
] }
```
`remove-effect.json`
```json
{ "name": "remove-effect", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" },
  { "op": "add_effect", "layer": "@L1", "kind": "brightness", "ref": "E2" },
  { "op": "remove_effect", "layer": "@L1", "effect": "@E1" }
] }
```
`remove-effect-not-found.json` (double remove → EffectNotFound; trailing add_layer gates no-burn)
```json
{ "name": "remove-effect-not-found", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" },
  { "op": "remove_effect", "layer": "@L1", "effect": "@E1" },
  { "op": "remove_effect", "layer": "@L1", "effect": "@E1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" }
] }
```
`add-effect-missing-layer-burns-id.json` (★ the keystone gate: the second `add_layer`'s id reveals whether the failed `add_effect` burned an id)
```json
{ "name": "add-effect-missing-layer-burns-id", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "delete_layer", "layer": "@L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L2" }
] }
```

- [ ] **Step 7: Regenerate oracles + run the gate.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the 9 new oracle files as ?? — no M
npx vitest run src/main/state/actor.test.ts src/main/state/__tests__/differential.phase2.test.ts
```
Expected: gate PASS at 103 sequences (94 + 9), `skipped === []`. If a sequence diverges, debug the TS path against the cited Rust; do NOT edit the oracle/gate. The regenerated oracle is the truth.

- [ ] **Step 8: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/add-effect.json apps/desktop/fixtures/state-corpus/sequences/update-effect-enabled.json apps/desktop/fixtures/state-corpus/sequences/update-effect-params.json apps/desktop/fixtures/state-corpus/sequences/update-effect-not-found.json apps/desktop/fixtures/state-corpus/sequences/move-effect-reorder.json apps/desktop/fixtures/state-corpus/sequences/move-effect-out-of-range.json apps/desktop/fixtures/state-corpus/sequences/remove-effect.json apps/desktop/fixtures/state-corpus/sequences/remove-effect-not-found.json apps/desktop/fixtures/state-corpus/sequences/add-effect-missing-layer-burns-id.json apps/desktop/fixtures/state-corpus/oracle/add-effect.json apps/desktop/fixtures/state-corpus/oracle/update-effect-enabled.json apps/desktop/fixtures/state-corpus/oracle/update-effect-params.json apps/desktop/fixtures/state-corpus/oracle/update-effect-not-found.json apps/desktop/fixtures/state-corpus/oracle/move-effect-reorder.json apps/desktop/fixtures/state-corpus/oracle/move-effect-out-of-range.json apps/desktop/fixtures/state-corpus/oracle/remove-effect.json apps/desktop/fixtures/state-corpus/oracle/remove-effect-not-found.json apps/desktop/fixtures/state-corpus/oracle/add-effect-missing-layer-burns-id.json
git commit -m "test(state-migration): effect chain ops live + corpus (Phase 2b-iii)"
```

---

## Task 3: Full suite green + README + whole-branch review + finish

- [ ] **Step 1: Full state suite + typecheck.**
`npx vitest run src/main/state` → all green (capture the count; ~340+ tests). `npm run typecheck` → clean. Confirm the differential gate reports 103 sequences with `skipped === []`.

- [ ] **Step 2: Update the corpus README** (`fixtures/state-corpus/README.md`).
  - In **gap #6** (`Caption tracks, effects, transitions, params`): strike "effects" from the deferred list — it's now covered — leaving "Caption tracks, transitions, params". Update the DEFERRED coverage-table row likewise (`Caption tracks / transitions / params`).
  - Add a new coverage section after the track-flags block:
    ```markdown
    | **— per-layer effects —** | |
    | add_effect (append, enabled:true, empty params) | add-effect.json |
    | update_effect enabled | update-effect-enabled.json |
    | update_effect params merge (insert + overwrite) | update-effect-params.json |
    | update_effect → EffectNotFound (removed) | update-effect-not-found.json |
    | move_effect reorder (0 = first) | move-effect-reorder.json |
    | move_effect → EffectIndexOutOfRange | move-effect-out-of-range.json |
    | remove_effect | remove-effect.json |
    | remove_effect → EffectNotFound (double remove) | remove-effect-not-found.json |
    | add_effect missing layer → LayerNotFound burns the effect id | add-effect-missing-layer-burns-id.json |
    ```

- [ ] **Step 3: Commit the README.**
```bash
git add apps/desktop/fixtures/state-corpus/README.md
git commit -m "docs(state-migration): corpus README — Phase 2b-iii effects coverage"
```

- [ ] **Step 4: Whole-branch code review** (superpowers:requesting-code-review). Scope: the Phase-2b-iii commits. Focus: (a) `applyAddEffect` mints the effect id UNCONDITIONALLY before the layer lookup (verified by `add-effect-missing-layer-burns-id` yielding the shifted later id + the unit test); (b) `update_effect` replaces `enabled` and MERGES `params` key-by-key (no deletion); (c) `move_effect` rejection order LayerNotFound → EffectNotFound → EffectIndexOutOfRange; (d) the driver change is purely additive (94 pre-existing oracles byte-identical via regen); (e) gate integrity preserved (`skipped === []`, every new oracle byte-identical).

- [ ] **Step 5:** superpowers:finishing-a-development-branch — confirm the integration choice (this work sits on local `main`; per Phase 0/1/2a/2b-i/2b-ii, default keep-local/unpushed unless the user says otherwise).

---

## Self-Review (author checklist — completed)

- **Spec coverage:** the four effect ops — add (Tasks 1-2), update enabled+params merge (Tasks 1-2), move reorder + out-of-range (Tasks 1-2), remove + not-found (Tasks 1-2); the id-mint asymmetry landmine gated by corpus + unit test. Closes the "effects" half of README gap #6. ✓
- **Placeholder scan:** every step has concrete code/commands/expected output. ✓
- **Type consistency:** `EffectPatch`/`applyAddEffect`/`applyUpdateEffect`/`applyMoveEffect`/`applyRemoveEffect` named identically across the producing task (Task 1) and the consuming task (Task 2 imports + dispatch arms); dispatch arg shapes (`layer`/`effect`/`kind`/`patch`/`new_index`) consistent between `buildArgs`, the dispatch arms, and the driver; error variants (`LayerNotFound`/`EffectNotFound`/`EffectIndexOutOfRange`) pre-exist in `errors.ts`. ✓
- **Landmines captured:** the `add_effect` unconditional-id-mint asymmetry vs `add_layer` (the keystone — Global Constraints + Task-1 comment + Task-1 unit test + the `add-effect-missing-layer-burns-id` corpus gate); additive-driver-change (94 oracles byte-identical); gate-ordering invariant (Task 1 ships no corpus; corpus follows BOTH-side wiring in Task 2); `update_effect` params-merge-no-deletion; `move_effect` EffectNotFound-before-index-bound; `Animated<f64>` wire shape for params; the `new_id` import-path fallback note for the driver. ✓
- **Ungated-by-corpus paths covered by unit tests:** `update_effect`/`move_effect`/`remove_effect` `LayerNotFound` (mint no id, low id-contract risk — unit-tested in `effects.test.ts`); params "do-not-touch" null handling (unit-tested). ✓
