# State-Actor TS Migration — Phase 2b-i Plan (`update_layer` + `fit_composition_to_layers`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This is the FIRST slice of **Phase 2b** of the master plan `2026-06-22-state-actor-ts-migration.md`. Read the **Phase-2a plan** (`…-phase-2a.md`) first — it built the group/split slice and the differential gate `differential.phase2.test.ts`. Phase 2b ports the remaining recorded mutations, which (unlike 2a) require **extending the Rust replay driver + corpus and REGENERATING oracles**.

**Goal:** Port `update_layer` (envelope patch) and `fit_composition_to_layers` to the TS actor, and — for the first time in this migration — **extend the Rust `replay_driver`, author new corpus sequences, and regenerate oracles** so these two mutations are gated byte-for-byte against the Rust actor. This slice deliberately uses two **no-ref, no-media** mutations to prove the oracle-regeneration workflow on the smallest possible surface before larger 2b slices.

**Architecture:** Same as Phase 1/2a — pure functions over an Immer draft, 1:1 with Rust `apply_*`/`do_*`; the actor's `commit` runs validate→record→emit. New: the differential corpus grows (new sequences + regenerated oracle traces), and the Rust `replay_driver` gains two op handlers. The TS differential gate (`differential.phase2.test.ts`) automatically picks up the new sequences once the replay vocabulary and oracles exist.

**Tech Stack:** TypeScript, Immer, Vitest, the `weftcut-eval` wasm leaf (`snapFrameRound`, UNCHANGED), the Rust `replay_driver` bin + `gen-state-oracle.mjs` (now exercised — needs the cargo/ffmpeg toolchain).

## Global Constraints

- **The oracle-regeneration toolchain (verified working 2026-06-22).** Regenerating oracles requires building `replay_driver` (which compiles the native crate incl. ffmpeg-next). Set these env vars before any `cargo`/regen, then run from `apps/desktop/`:
  ```bash
  export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
  export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
  export PATH="$FFMPEG_DIR/bin:$PATH"
  node scripts/gen-state-oracle.mjs   # builds replay_driver, runs each sequence 2× (determinism gate), writes oracle/*.json
  ```
  The build feature set is baked into `gen-state-oracle.mjs` (`--features replay,jobs,export,mcp,cloud,motifs`; bare `replay` fails on a pre-existing `napi_backend.rs` error). The committed oracles already match the current Rust (regen is git-clean for unchanged sequences), so a regen after an ADDITIVE driver change must leave the 62 existing oracles byte-identical and add only the new ones.
- **`update_layer` does NOT autofit.** `apply_update_layer` (`mutations.rs:332-362`) applies the envelope patch and returns — it does **not** call `apply_duration_autofit`. So changing `t_end_us` via `update_layer` does NOT grow/shrink `composition.duration_us`. Do NOT add an autofit call. (Contrast: `move`/`trim`/`fit` DO autofit.) The differential gate enforces this.
- **`check_track_lock` runs FIRST in `update_layer`** (locked track rejects even `t_start`/`t_end` edits) — `LayerNotFound` if the layer is missing, `TrackLocked` if its track is locked, before any field is applied.
- **Patch fields apply only when present.** Rust `LayerPatch` fields are `Option<_>`; serde treats `null` and absent both as `None` (skip). Mirror exactly: apply a field only when it is a value of the right type (`typeof` guard), treating `null`/`undefined` as "don't touch".
- **`fit_composition_to_layers` is RECORDED** (`do_fit_composition_to_layers`, `actor.rs:3084-3099` — "always records an entry"): `duration_pinned = false` then `apply_duration_autofit`, via `commit`.
- **The wasm snap leaf is sacred** — never reimplemented.
- **id contract (unchanged):** `commit` allocates the op_id AFTER `validate` succeeds; `update_layer` and `fit` allocate NO entity id. A successful op burns one op_id; a failed validate burns none.
- **`CommandError` variant names match Rust** (`TrackLocked`, `LayerNotFound`, `ValidationFailed`) — all already in `errors.ts`.
- **TimeUs is `number`.** Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `git add` by **explicit path only** (parallel sessions). Work on local `main`; do NOT push. TDD, frequent commits, DRY, YAGNI.

### Gate-ordering invariant (why the task order matters)

`differential.phase2.test.ts` asserts `skipped === []` over the live corpus dir. So the replay **vocabulary** (`SUPPORTED_OPS`) must support an op BEFORE any corpus sequence using it exists, or the gate breaks. Therefore: Task 1 (TS mutations, gate untouched) → Task 2 (dispatch + vocab, still no new sequences, gate green) → Task 3 (driver + new sequences + regen, gate lights up and must pass). Never add a corpus sequence whose op isn't already in `SUPPORTED_OPS`.

### Reference Rust sources (cite; re-read only if a differential step diverges)

`apply_update_layer` (`native/src/state/actor/mutations.rs:332-362`), `LayerPatch` (`actor.rs:79-90`), `ProjectHandle::update_layer` (`actor.rs:1180-1197`) / `::fit_composition_to_layers` (`actor.rs:1384-1394`), `do_update_layer` (`actor.rs:2716-2732`), `do_fit_composition_to_layers` (`actor.rs:3084-3099`), `apply_duration_autofit` (`mutations.rs:28-42`). Driver: `native/src/bin/replay_driver.rs` (`apply()` match, `resolve_id`, `CompositionPatch{..Default}` idiom).

---

## File Structure

All paths under `apps/desktop/`. Vitest from `apps/desktop/` (`npx vitest run <path>`).

| Path | Responsibility | New/Mod |
|---|---|---|
| `src/main/state/mutations/update.ts` | `applyUpdateLayer(p, id, patch)` + the `LayerPatch` TS type. | **New** |
| `src/main/state/mutations/composition.ts` | `applyFitComposition(p)` (will grow with `set_composition`-full in a later 2b slice). | **New** |
| `src/main/state/actor.ts` | `update_layer` + `fit_composition_to_layers` dispatch arms. | Mod |
| `src/main/state/replay.ts` | `SUPPORTED_OPS` + `buildArgs` for the two ops. | Mod |
| `native/src/bin/replay_driver.rs` | `update_layer` + `fit_composition_to_layers` op handlers in `apply()`. | Mod |
| `fixtures/state-corpus/sequences/*.json` | New sequences (label/times/flags/overlap-reject/undo for update_layer; shrink/grow for fit). | **New** |
| `fixtures/state-corpus/oracle/*.json` | Regenerated oracle traces for the new sequences. | **New (generated)** |
| `fixtures/state-corpus/README.md` | Move `update_layer`/`fit` out of PHASE-2B GAPS into the coverage table. | Mod |

---

## Task 1: TS mutations — `applyUpdateLayer` + `applyFitComposition`

**Files:**
- Create: `src/main/state/mutations/update.ts`, `src/main/state/mutations/composition.ts`
- Test: `src/main/state/mutations/update.test.ts`, `src/main/state/mutations/composition.test.ts`

**Interfaces:**
- Produces: `LayerPatch` type; `applyUpdateLayer(p: Project, id: Uuid, patch: LayerPatch): void`; `applyFitComposition(p: Project): void`.
- Consumes: `checkTrackLock`, `locateLayer`, `applyDurationAutofit` from `./helpers`; `CommandFailure` from `../errors`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/state/mutations/update.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyUpdateLayer } from './update'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function one(): Project { const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [color('a', 0, 1_000_000)]; return p }
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }

describe('applyUpdateLayer', () => {
  it('applies only the provided fields (label/times/flags)', () => {
    const p = one()
    applyUpdateLayer(p, 'a', { label: 'hi', t_end_us: 2_000_000, enabled: false })
    const l = p.tracks[0].layers[0]
    expect(l.label).toBe('hi'); expect(l.t_end_us).toBe(2_000_000); expect(l.enabled).toBe(false)
    expect(l.t_start_us).toBe(0); expect(l.locked).toBe(false) // untouched
  })
  it('treats null/absent patch fields as "do not touch"', () => {
    const p = one()
    applyUpdateLayer(p, 'a', { label: null, t_start_us: null })
    const l = p.tracks[0].layers[0]
    expect(l.label).toBeNull(); expect(l.t_start_us).toBe(0) // unchanged
  })
  it('does NOT autofit composition.duration_us on a t_end change (mutations.rs:332-362)', () => {
    const p = one(); p.composition.duration_us = 1_000_000; p.composition.duration_pinned = false
    applyUpdateLayer(p, 'a', { t_end_us: 5_000_000 })
    expect(p.composition.duration_us).toBe(1_000_000) // unchanged — update_layer never autofits
  })
  it('throws LayerNotFound for a missing layer', () => {
    expectCmd(() => applyUpdateLayer(one(), 'ghost', { enabled: false }), 'LayerNotFound')
  })
  it('throws TrackLocked when the layer is on a locked track (ungated by corpus)', () => {
    const p = one(); p.tracks[0].locked = true
    expectCmd(() => applyUpdateLayer(p, 'a', { t_end_us: 2_000_000 }), 'TrackLocked')
  })
})
```

```ts
// src/main/state/mutations/composition.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyFitComposition } from './composition'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

describe('applyFitComposition', () => {
  it('unpins and refits duration to the layer high-water mark (shrink)', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [color('a', 0, 2_000_000)]
    p.composition.duration_pinned = true; p.composition.duration_us = 9_000_000
    applyFitComposition(p)
    expect(p.composition.duration_pinned).toBe(false)
    expect(p.composition.duration_us).toBe(2_000_000)
  })
  it('refits to 0 when there are no layers', () => {
    const p = blankProject(seededGen(), 't'); p.composition.duration_pinned = true; p.composition.duration_us = 5_000_000
    applyFitComposition(p)
    expect(p.composition.duration_us).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/main/state/mutations/update.test.ts src/main/state/mutations/composition.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// src/main/state/mutations/update.ts
import type { Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { checkTrackLock, locateLayer } from './helpers'

/** Mirrors native/src/state/actor.rs:79-90 LayerPatch. null/absent = "don't touch". */
export interface LayerPatch {
  label?: string | null
  t_start_us?: number | null
  t_end_us?: number | null
  enabled?: boolean | null
  locked?: boolean | null
}

/** mutations.rs:332-362 — envelope-only patch. check_track_lock FIRST (rejects
 *  edits on a locked track / missing layer), then apply only the provided fields.
 *  Does NOT autofit (Rust doesn't — a t_end edit here never moves composition.duration_us). */
export function applyUpdateLayer(p: Project, id: Uuid, patch: LayerPatch): void {
  checkTrackLock(p, id) // throws LayerNotFound (missing) or TrackLocked (locked track)
  const loc = locateLayer(p, id)! // existence guaranteed by checkTrackLock
  const layer = p.tracks[loc[0]].layers[loc[1]]
  if (typeof patch.label === 'string') layer.label = patch.label
  if (typeof patch.t_start_us === 'number') layer.t_start_us = patch.t_start_us
  if (typeof patch.t_end_us === 'number') layer.t_end_us = patch.t_end_us
  if (typeof patch.enabled === 'boolean') layer.enabled = patch.enabled
  if (typeof patch.locked === 'boolean') layer.locked = patch.locked
}
```

```ts
// src/main/state/mutations/composition.ts
import type { Project } from '../model'
import { applyDurationAutofit } from './helpers'

/** actor.rs:3084-3099 — unpin, then refit duration to the layer high-water mark.
 *  Recorded (the actor commits this). Inverse of an explicit set_composition{duration_us}. */
export function applyFitComposition(p: Project): void {
  p.composition.duration_pinned = false
  applyDurationAutofit(p)
}
```

- [ ] **Step 4: Run to verify they pass** — same command → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
# from apps/desktop/: npm run typecheck   (tsc -b, clean)
git add apps/desktop/src/main/state/mutations/update.ts apps/desktop/src/main/state/mutations/update.test.ts apps/desktop/src/main/state/mutations/composition.ts apps/desktop/src/main/state/mutations/composition.test.ts
git commit -m "feat(state-migration): applyUpdateLayer + applyFitComposition (Phase 2b-i)"
```

---

## Task 2: Dispatch arms + replay vocabulary

**Files:**
- Modify: `src/main/state/actor.ts`, `src/main/state/replay.ts`
- Test: `src/main/state/actor.test.ts` (add cases)

**Interfaces:**
- Consumes: `applyUpdateLayer`, `LayerPatch` from `./mutations/update`; `applyFitComposition` from `./mutations/composition`.
- Produces: dispatch handles `update_layer` + `fit_composition_to_layers`; `SUPPORTED_OPS` gains both; `buildArgs` cases for both.

- [ ] **Step 1: Add failing dispatch tests**

```ts
// add to src/main/state/actor.test.ts
describe('dispatch: update_layer + fit_composition_to_layers', () => {
  it('update_layer patches the envelope; fit refits duration', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'd'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l = actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(l.ok).toBe(true)
    const lid = (l as { ok: true; value: unknown }).value as string
    expect(actor.dispatch('update_layer', { layer: lid, patch: { t_end_us: 4_000_000, label: 'x' } }).ok).toBe(true)
    const snap = actor.snapshot()
    const layer = snap.tracks.flatMap((t) => t.layers).find((x) => x.id === lid)!
    expect(layer.t_end_us).toBe(4_000_000); expect(layer.label).toBe('x')
    expect(snap.composition.duration_us).toBe(0) // update_layer did NOT autofit
    expect(actor.dispatch('fit_composition_to_layers', {}).ok).toBe(true)
    expect(actor.snapshot().composition.duration_us).toBe(4_000_000) // fit refit to layer end
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops).

- [ ] **Step 3: Wire `actor.ts`** — add imports and two dispatch arms before `default`:

```ts
import { applyUpdateLayer, type LayerPatch } from './mutations/update'
import { applyFitComposition } from './mutations/composition'
```
```ts
        case 'update_layer': commit('Updated layer', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => applyUpdateLayer(d, a.layer as Uuid, a.patch as LayerPatch)); return { ok: true, value: null }
        case 'fit_composition_to_layers': commit('Fit composition duration to layers', [], { kind: 'Composition' }, (d) => applyFitComposition(d)); return { ok: true, value: null }
```

- [ ] **Step 4: Wire `replay.ts`** — `SUPPORTED_OPS` add `'update_layer'`, `'fit_composition_to_layers'`; `buildArgs` add:

```ts
    case 'update_layer': return { layer: resolve(refs, cmd.layer), patch: { label: cmd.label, t_start_us: cmd.t_start_us, t_end_us: cmd.t_end_us, enabled: cmd.enabled, locked: cmd.locked } }
    case 'fit_composition_to_layers': return {}
```
(Corpus sequences carry patch fields at the top level of the command, mirroring how the Rust driver reads `cmd["t_end_us"]` etc.; absent fields are `undefined` → skipped by `applyUpdateLayer`'s typeof guards, exactly as Rust's `as_i64()`→`None`.)

- [ ] **Step 5: Run actor tests + the differential gate (must stay green — no new sequences yet)**

`npx vitest run src/main/state/actor.test.ts src/main/state/__tests__/differential.phase2.test.ts`
Expected: PASS. The gate is unchanged — adding ops to the vocabulary with no sequences using them keeps `skipped===[]` and all 62 sequences matching.

- [ ] **Step 6: Typecheck + commit**

```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/actor.test.ts
git commit -m "feat(state-migration): dispatch + replay vocab for update_layer + fit_composition"
```

---

## Task 3: INTEGRATION — extend driver, author sequences, regenerate oracles, light up the gate

**Files:**
- Modify: `native/src/bin/replay_driver.rs`
- Create: new sequence + oracle files under `fixtures/state-corpus/{sequences,oracle}/`
- Modify: `fixtures/state-corpus/README.md`

**Interfaces:** none (corpus + driver). Exit: the differential gate runs the new sequences and matches byte-for-byte.

- [ ] **Step 1: Extend the Rust driver**

In `native/src/bin/replay_driver.rs`: extend the import to `use weftcut_lib::state::actor::{LayerEdge, CompositionPatch, LayerPatch};` and add two arms to the `apply()` match (before the `other =>` arm):

```rust
        "update_layer" => {
            let patch = LayerPatch {
                label: cmd["label"].as_str().map(str::to_string),
                t_start_us: cmd["t_start_us"].as_i64(),
                t_end_us: cmd["t_end_us"].as_i64(),
                enabled: cmd["enabled"].as_bool(),
                locked: cmd["locked"].as_bool(),
            };
            h.update_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), patch).await.map_err(|e| format!("{e:?}"))
        }
        "fit_composition_to_layers" => h.fit_composition_to_layers(u).await.map_err(|e| format!("{e:?}")),
```

- [ ] **Step 2: Author the new corpus sequences** under `fixtures/state-corpus/sequences/` (one invariant per file; patch fields at the command top level). Author exactly these:

`update-layer-label.json`
```json
{ "name": "update-layer-label", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "update_layer", "layer": "@L1", "label": "intro" }
] }
```
`update-layer-times.json`
```json
{ "name": "update-layer-times", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "update_layer", "layer": "@L1", "t_start_us": 500000, "t_end_us": 2000000 }
] }
```
`update-layer-flags.json`
```json
{ "name": "update-layer-flags", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "update_layer", "layer": "@L1", "enabled": false, "locked": true }
] }
```
`update-layer-overlap-reject.json`
```json
{ "name": "update-layer-overlap-reject", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "update_layer", "layer": "@L2", "t_start_us": 500000, "t_end_us": 1500000 }
] }
```
`update-layer-undo.json`
```json
{ "name": "update-layer-undo", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "update_layer", "layer": "@L1", "t_end_us": 4000000 },
  { "op": "undo" }
] }
```
`fit-composition-shrink.json`
```json
{ "name": "fit-composition-shrink", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "set_composition", "duration_us": 9000000 },
  { "op": "fit_composition_to_layers" }
] }
```
`fit-composition-undo.json`
```json
{ "name": "fit-composition-undo", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "set_composition", "duration_us": 9000000 },
  { "op": "fit_composition_to_layers" },
  { "op": "undo" }
] }
```

> The `update-layer-overlap-reject` sequence expects the third step to fail `ValidationFailed(LayerOverlap)` (moving L2 to overlap L1). The oracle (generated next) captures whatever the Rust actor actually does — if Rust's behavior differs from this expectation, the oracle is the truth and the TS must match it; investigate only if the TS diverges from the regenerated oracle.

- [ ] **Step 3: Regenerate the oracles** (the new workflow — env vars per Global Constraints):

```bash
# from apps/desktop/
export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
export PATH="$FFMPEG_DIR/bin:$PATH"
node scripts/gen-state-oracle.mjs
```
Expected: `ok  <name>` for every sequence (incl. the 7 new ones), exit 0. Then verify the 62 PRE-EXISTING oracles are byte-identical (additive driver change must not perturb them):
```bash
git status --short fixtures/state-corpus/oracle/   # should list ONLY the 7 new oracle files as added (??), no modified (M) existing oracles
```
If any existing oracle shows as Modified, STOP — the driver change was not purely additive; investigate before proceeding.

- [ ] **Step 4: Run the differential gate — the moment of truth**

`npx vitest run src/main/state/__tests__/differential.phase2.test.ts`
Expected: PASS — now 69 sequences (62 + 7), `skipped===[]`, every step byte-identical to the regenerated oracle. The new sequences exercise `update_layer` (label/times/flags/overlap-reject/undo) and `fit_composition_to_layers` (shrink/undo). If a new sequence diverges, the failure names the file/step/op + the canonical-state diff — debug the TS mutation (Task 1) against the cited Rust; do NOT edit the oracle or the gate.

- [ ] **Step 5: Update the corpus README** — move `update_layer` and `fit_composition_to_layers` from "PHASE-2B GAPS" item #7 (set_composition fit) into the coverage table with their sequence files; note the remaining `set_composition` fps/canvas path is still deferred.

- [ ] **Step 6: Commit** (driver + sequences + oracles + README, explicit paths)

```bash
git add apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/update-layer-label.json apps/desktop/fixtures/state-corpus/sequences/update-layer-times.json apps/desktop/fixtures/state-corpus/sequences/update-layer-flags.json apps/desktop/fixtures/state-corpus/sequences/update-layer-overlap-reject.json apps/desktop/fixtures/state-corpus/sequences/update-layer-undo.json apps/desktop/fixtures/state-corpus/sequences/fit-composition-shrink.json apps/desktop/fixtures/state-corpus/sequences/fit-composition-undo.json apps/desktop/fixtures/state-corpus/oracle/update-layer-label.json apps/desktop/fixtures/state-corpus/oracle/update-layer-times.json apps/desktop/fixtures/state-corpus/oracle/update-layer-flags.json apps/desktop/fixtures/state-corpus/oracle/update-layer-overlap-reject.json apps/desktop/fixtures/state-corpus/oracle/update-layer-undo.json apps/desktop/fixtures/state-corpus/oracle/fit-composition-shrink.json apps/desktop/fixtures/state-corpus/oracle/fit-composition-undo.json apps/desktop/fixtures/state-corpus/README.md
git commit -m "test(state-migration): replay-driver + corpus + oracles for update_layer + fit (Phase 2b-i)"
```

---

## Task 4: Full suite green + whole-branch review + finish

- [ ] **Step 1:** `npx vitest run src/main/state` → all green (capture count). `npm run typecheck` → clean.
- [ ] **Step 2:** Request a whole-branch code review (superpowers:requesting-code-review). Scope: the Phase-2b-i commits. Focus: (a) `update_layer` faithfully omits autofit and applies only provided fields with the lock-check-first order; (b) `fit_composition` matches Rust (unpin + autofit, recorded); (c) the driver extension is purely additive (existing oracles unperturbed) and the new sequences/oracles are byte-identical via the gate; (d) gate integrity preserved (`skipped===[]`).
- [ ] **Step 3:** superpowers:finishing-a-development-branch — confirm the integration choice (this work sits on local `main`; per Phase 0/1/2a, default keep-local/unpushed unless the user says otherwise).

---

## Self-Review (author checklist — completed)

- **Spec coverage:** the master-plan Phase-2 "remaining recorded mutations" begins here with `update_layer` + `fit_composition_to_layers`; both fully ported, dispatched, and differential-gated via newly-regenerated oracles. ✓
- **New workflow proven:** Task 3 exercises the full extend-driver→author-sequences→regen-oracle→gate loop on the smallest no-ref/no-media surface — de-risking it for larger 2b slices (markers/effects/transitions/media). ✓
- **Type consistency:** `applyUpdateLayer`/`applyFitComposition`/`LayerPatch` named identically across tasks; error variants pre-exist in `errors.ts`. ✓
- **Landmines captured:** `update_layer` never autofits; lock-check-first; patch-field skip semantics; `fit` is recorded; gate-ordering invariant; additive-driver-change verification (existing oracles must stay byte-identical). ✓
- **Ungated paths:** `TrackLocked` (no lock op in corpus) and `LayerNotFound` for `update_layer` are covered by Task-1 unit tests, not the differential gate. ✓

## Phase-2b-ii+ carry-forwards (NOT this plan)

- 2b-ii: generalize the driver's ref-capture (currently only `add_layer` captures a `ref`) so `add_track`/`groups_create`/`add_marker`/`add_effect`/`add_transition` returns can be addressed → unlocks markers (`update_marker`/`remove_marker`), `groups_dissolve`/`add_members`/`remove_members`/`rename`, custom-track `delete_track`/`move_track`, and a `lock_layer`/`lock_track` driver op (to gate the GroupLockedMember/TrackLocked paths currently unit-test-only).
- 2b-iii effects; 2b-iv transitions + `set_composition`-full (fps re-snap; the existing `actor.ts setComposition` already has a partial fps path to gate/complete); 2b-v media-bearing layers + media pool ops + `separate_audio` + params (`update_layer_params`/`update_layer_param_track(s)`/`rebind_motif`); 2b-vi captions + `set_role_gain`/`update_role_flags`/`update_project_settings`/`update_track_flags`.
