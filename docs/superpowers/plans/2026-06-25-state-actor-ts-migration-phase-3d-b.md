# Phase 3d-b — MCP keyframe tools + dry_run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 8 MCP keyframe tools (`set_keyframe`/`remove_keyframe`/`retime_keyframe`/`set_keyframe_easing`/`smooth_keyframes`/`clear_keyframes`/`set_param_track`/`get_param_track`) and `dry_run` onto the TS state actor as a DORMANT, differential-gated extension of the 3d-a `actor.mcpCall` adapter (no live routing; the `server.ts` flip + un-pause is Phase 3d-d).

**Architecture:** The keyframe tools reuse the renderer's golden-tested algorithm module `src/renderer/keyframe/edits.ts` (crossing the project boundary exactly like `snap.ts` re-exports the wasm eval leaf — the same Phase-4 view-type-unification debt). `edits.ts` gains a backward-compatible injectable id source so the MCP path mints keyframe ids from the actor's deterministic `idGen` (matching Rust `new_id()` order). A new pure `readLayerTrack`/`resolveAnimatedF64` reader (mirroring `native/src/state/layer.rs`) supplies the `(t_start_us, current track)` each tool needs for timeline-absolute↔layer-local conversion; the computed `Animated<f64>` is committed through the already-gated `update_layer_param_track` dispatch. `dry_run` extends the existing `actor.dryRun` (and its `DryRunOp`/`DryRunOutput` types) to the 3 op kinds the MCP `OperationSpec` exposes (`UpdateLayer`/`UpdateLayerParams`/`SplitLayer`) and shapes the `DryRunResponse` envelope. The Rust `mcp_driver` (3d-a) drives the REAL `dispatch_tool` for these 9 tools with ZERO Rust handler changes — only a `kf_index` capture convention is added so a corpus sequence can reference a server-minted keyframe id read back via `get_param_track`.

**Tech Stack:** TypeScript (Electron main, vitest/esbuild), Rust (napi-rs addon + `bin` drivers, `serde_json`), the existing `fixtures/state-corpus` differential harness.

## Global Constraints

- DORMANT slice: **NO change to `src/main/index.ts`, `src/main/mcp/server.ts`, or `src/main/mcp/mutationTools.ts`.** The MCP mutation pause stays as-is; nothing goes live. Verified by diff in Task 5.
- Corpus changes are **ADDITIVE**: existing oracle dirs (`oracle/`, `oracle-summary/`, `oracle-prod/`, `oracle-mcp/`) stay byte-identical — `git diff --diff-filter=M fixtures/state-corpus` over those dirs must be empty after regen. (3d-a's `oracle-mcp/` is the prior baseline; 3d-b only ADDS files to it.)
- `dispatch()` and `command()` (the replay/prod vehicles) stay **byte-untouched** — the keyframe + dry_run logic extends `mcpCall` and `dryRun`, both new/owned surfaces.
- Error gating = **`code` + structured `data` byte-identical + state byte-identical** (state pins ok/no-op). The prose `message` is generated reasonably but NOT asserted byte-equal, EXCEPT `InvalidArgument` whose `"{field}: {detail}"` message IS reproduced exactly. Keyframe errors (`LayerNotFound`/`UnknownKeyframeParam`/`EmptyKeyframeTrack` → `invalid_params` no data; `KeyframeNotFound` → `invalid_params` no data) are code-gated; their prose is ungated. (Matches the 3d-a `errKey` comparison.)
- `dry_run` differential corpus uses **succeeding ops only** (`halted_at:null`, every result `status:"ok"`) so the gate never asserts a per-op `CommandError` Display string (those are deliberately NOT twinned, per the 3d-a error-gating decision). The halt-on-error path + error-string formatting is **unit-tested** TS-side (Task 4), not differential-gated.
- The wasm eval leaf is sacred: `edits.ts`'s transitive `../eval` dependency (via `render/animated`) is the same leaf `snap.ts` re-exports; main already `await initEval()`s it at boot (3c-ii-d) and the vitest setup inits it in `beforeAll`. Do NOT reimplement snap/eval.
- Structured ToolResult JSON (`get_param_track`, `dry_run`) must serialize with **alpha-sorted keys** to match Rust `serde_json` (preserve_order OFF → BTreeMap / `json!` Map). Use `toolJson` (= `canonicalize` + `JSON.stringify`).
- The MCP agent actor is `Actor::Agent{client:"mcp"}` — corpus uses det ids so actor attribution doesn't affect serialized state.
- Regen toolchain env (Windows): `FFMPEG_DIR=<…Gyan.FFmpeg.Shared…/ffmpeg-8.1.1-full_build-shared>`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH=$FFMPEG_DIR/bin:$PATH`; build `--features replay,jobs,export,mcp,cloud,motifs`. (Controller-run; per-task reviewers do NOT run cargo/regen — the controller verifies `tsc -b` since vitest uses esbuild and won't catch type errors.)
- Branch: `phase-3d-b-keyframes` (created in Task 1 Step 0; plan doc committed first).

## Background facts (verified vs code — read before implementing)

- **Rust handlers** live in `native/src/mcp/keyframes.rs` (arg structs + helpers) and `native/src/mcp/tools.rs` (`dry_run`, `map_command_error`, `agent_actor`). All 9 tools are registered in `native/src/mcp/catalog.rs` (`tool_table!`) and routed by `dispatch_tool` — **no Rust handler edits needed**; `mcp_driver` already drives `dispatch_tool`.
- **Each keyframe tool** (keyframes.rs): `read_track(project, layer_id, param_key) -> (t_start_us, Animated<f64>)` [LayerNotFound → UnknownKeyframeParam, read-only], then optionally `require_key` (KeyframeNotFound), then a `keyframe_edits::*` algorithm, then `update_layer_param_track(actor, layer, param_key, new)`. Times in args are **timeline-absolute**; the helper converts to layer-local via `t_us - t_start_us` (and back, `+ t_start_us`, for `get_param_track`'s `t_us`).
- **`resolve_animated_f64_on_layer`** (layer.rs:369) param vocabulary: VideoClip/ImageOverlay/Text/Motif → `x`/`y`/`scale_x`/`scale_y`/`rotation_deg`/`opacity`; Audio → `gain_db`/`pan`; Color → **none** (so keyframe corpus sequences must NOT use a Color layer — use a no-audio VideoClip layer via `add_video_layer`); effect path `effects[<uuid>].params[<key>]` reads `effect.params.get(k)` → `None` (→ UnknownKeyframeParam) when the slot is absent.
- **`Interpolation`** serde (eval/src/lib.rs): `#[serde(tag="kind")]` → `{"kind":"Linear"}`, Bezier `{"kind":"Bezier","p1":[x,y],"p2":[x,y]}`. **Identical** to the renderer `edits.ts` form AND the main `model.ts` `Interpolation` — pass interp objects straight through, no transform.
- **`Animated<f64>`** serde: `{"mode":"Static","value":v}` / `{"mode":"Keyframed","value":[<keyframe>...]}`. `Keyframe` = `{id,t_us,value,interp}`. Structurally identical across renderer `AnimTrack<number>` and main `Animated<number>` — the renderer algorithm's output drops straight into `applyUpdateLayerParamTrack`.
- **`get_param_track` result shape** (keyframes.rs:165) is a CUSTOM JSON, NOT the raw `Animated` serde: Static → `{"mode":"Static","value":v}`; Keyframed → `{"mode":"Keyframed","keyframes":[{"id","t_us":<local+t_start>,"t_local_us":<local>,"value","interp"}]}`. (`set_param_track` INPUT, by contrast, IS the raw `Animated` serde with the `value` array and timeline-absolute `t_us`.)
- **`update_layer_param_track`** on the actor re-normalizes (snap-to-frame / sort / dedupe-last) layer-local times and does NOT re-resolve the param key. TS `applyUpdateLayerParamTrack` (mutations/params.ts) does the same + throws `EmptyKeyframeTrack` on an empty Keyframed track.
- **id-allocation contract** (the keystone): a `set_keyframe` that inserts a NEW key mints the keyframe id (Rust `new_id()` inside `upsert`) BEFORE the commit op_id (`update_layer_param_track`). The TS path must mint the keyframe id from the actor's `idGen` during the `upsertKeyframe` compute, THEN dispatch (commit → op_id). Update-existing-key, remove, retime, set-easing, smooth, clear, set_param_track mint NO keyframe id (only the op_id). `clear_keyframes` on an already-Static track mints NOTHING (no commit). `dry_run` AddLayer/SplitLayer DO mint ids (apply runs on the clone before discard) — both engines advance the det counter identically.
- **`dry_run`** (tools.rs:1658): `OperationSpec[]` (tagged `kind`, snake_case: `add_color_layer`/`add_video_layer`/`update_layer`/`update_layer_params`/`move_layer`/`split_layer`/`delete_layer`) → `spec_to_op` → `DryRunOp[]` → `b.project().dry_run(ops)` → `DryRunResponse{results:[{index, status:"ok"|"error", output|error}], halted_at}`. `do_dry_run` clones state, applies+validates each op, halts at first error. `DryRunOutput` serde (`tag="kind", rename_all="snake_case"`): `add_layer{layer_id}` / `split_layer{left_id,right_id}` / `void`.
- **TS `DryRunOp`/`DryRunOutput`/`dryRun`** (actor.ts:39-44, 300-323) currently cover only `AddLayer`/`DeleteLayer`/`MoveLayer`/`TrimLayer` and `AddLayer`/`Void` — MISSING `UpdateLayer`/`UpdateLayerParams`/`SplitLayer` (op) and `SplitLayer` (output). Task 4 extends them.

## File Structure

- Modify `apps/desktop/src/renderer/keyframe/edits.ts` — add injectable id + optional `interp` to `liftToKeyframed`/`upsertKeyframe` (backward-compatible; renderer call sites unchanged).
- Create `apps/desktop/src/main/state/keyframeEdits.ts` — re-export of the keyframe algorithms for a stable main-process import surface (mirrors `snap.ts`).
- Modify `apps/desktop/src/main/state/mutations/params.ts` — add `resolveAnimatedF64` (reader) + `readLayerTrack`.
- Modify `apps/desktop/src/main/state/mcp-commands.ts` — `KEYFRAME_PARAM` note + `shapeGetParamTrack` + `shapeDryRunResponse` + `dryRunError` helper + `MCP_TOOLS` additions.
- Modify `apps/desktop/src/main/state/actor.ts` — `mcpCall` keyframe + `dry_run` arms; extend `DryRunOp`/`DryRunOutput` + the `dryRun` switch.
- Modify `apps/desktop/src/main/state/replay.ts` — `resolveWire` skips `kf_index`; `mcpRefId` get_param_track capture.
- Modify `apps/desktop/native/src/bin/mcp_driver.rs` — `build_args` skips `kf_index`; `extract_ref_id` get_param_track keyframe-id capture.
- Create `apps/desktop/src/main/state/__tests__/mcp.dryrun.test.ts` — TS-only unit gate for the dry_run halt/error path (ungated by the differential).
- Create `apps/desktop/fixtures/state-corpus/sequences-mcp/*.json` + generated `oracle-mcp/*.json` (keyframes + dry_run).
- Modify `apps/desktop/fixtures/state-corpus/README.md` — extend the mcp dimension note (Task 5).

The differential gate `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts` (3d-a) is REUSED unchanged — it already asserts per-step `state` + `env.result` (ok) byte-identical and `errKey` (code+data) on error. The new sequences flow through it automatically.

---

### Task 1: `edits.ts` injectable id + `interp`, main re-export, `readLayerTrack` reader (TS infra; no MCP yet)

**Files:**
- Modify: `apps/desktop/src/renderer/keyframe/edits.ts`
- Create: `apps/desktop/src/main/state/keyframeEdits.ts`
- Modify: `apps/desktop/src/main/state/mutations/params.ts`
- Create: `apps/desktop/src/main/state/mutations/params.readtrack.test.ts`

**Interfaces:**
- Consumes: renderer `edits.ts` algorithms; `Layer`/`Project`/`Animated`/`Uuid` (model), `CommandFailure` (errors), `locateLayer` (helpers), `parseEffectParamKey`/`TRANSFORM_F64_KEYS` (params.ts, existing).
- Produces:
  - `liftToKeyframed(value, tUs, interp?, mkId?)`, `upsertKeyframe(track, tUs, value, interp?, mkId?)` — new optional trailing params (`interp?: Interpolation`, `mkId: () => string = newId`).
  - `src/main/state/keyframeEdits.ts` re-exporting `{ liftToKeyframed, upsertKeyframe, removeKeyframe, retimeKeyframe, setKeyframeInterp, smoothKeyframe, smoothTrack }`.
  - `resolveAnimatedF64(layer: Layer, key: string): Animated<number> | null` and `readLayerTrack(p: Project, id: Uuid, paramKey: string): { tStartUs: number; track: Animated<number> }` (params.ts).

- [ ] **Step 0: Create the branch and commit this plan.**

```bash
cd /c/Users/jonny/Desktop/learning/videtor
git checkout -b phase-3d-b-keyframes
git add apps/desktop/docs/superpowers/plans/2026-06-25-state-actor-ts-migration-phase-3d-b.md 2>/dev/null || git add docs/superpowers/plans/2026-06-25-state-actor-ts-migration-phase-3d-b.md
git commit -m "docs(state-migration): Phase 3d-b plan (MCP keyframes + dry_run)"
```
(The plan lives at the repo-root `docs/superpowers/plans/` — the second `git add` path is the real one; the first is a harmless no-op guard.)

- [ ] **Step 1: Make `edits.ts` id-injectable + interp-aware (backward-compatible).**

In `apps/desktop/src/renderer/keyframe/edits.ts`, replace `liftToKeyframed` and `upsertKeyframe` (lines 15-48) with:

```typescript
export function liftToKeyframed(
  value: number,
  tUs: number,
  interp: Interpolation = DEFAULT_INTERP,
  mkId: () => string = newId,
): AnimTrack<number> {
  return { mode: "Keyframed", value: [{ id: mkId(), t_us: tUs, value, interp }] };
}

/// Insert-or-update a key at `tUs`. A Static track is lifted (the new key is
/// the only key). An existing key at exactly `tUs` is updated in place (value
/// always; interp only when `interp` is given); else a new key is inserted
/// (interp = given, else copied from the preceding key, else Linear). `mkId`
/// is injected so the main-process MCP path can mint deterministic keyframe
/// ids from the actor's seeded id generator (matching Rust `new_id()` order);
/// the renderer keeps the `crypto.randomUUID` default.
export function upsertKeyframe(
  track: AnimTrack<number>,
  tUs: number,
  value: number,
  interp?: Interpolation,
  mkId: () => string = newId,
): AnimTrack<number> {
  if (track.mode === "Static") return liftToKeyframed(value, tUs, interp ?? DEFAULT_INTERP, mkId);
  const keys = track.value.slice();
  const at = keys.findIndex((k) => k.t_us === tUs);
  if (at >= 0) {
    keys[at] = { ...keys[at]!, value, ...(interp !== undefined ? { interp } : {}) };
    return { mode: "Keyframed", value: keys };
  }
  const prev = keys.filter((k) => k.t_us < tUs).pop();
  const resolved = interp ?? prev?.interp ?? DEFAULT_INTERP;
  keys.push({ id: mkId(), t_us: tUs, value, interp: resolved });
  keys.sort((a, b) => a.t_us - b.t_us);
  return { mode: "Keyframed", value: keys };
}
```

Rationale vs Rust `keyframe_edits::upsert`: new-key interp = `interp.unwrap_or(inherited)` where inherited = prev's interp or DEFAULT; existing-key updates value always and interp only if provided. This now matches exactly. The renderer's existing call sites (`upsertKeyframe(track, tUs, value)`) are unaffected (the two new params are optional with defaults), and the golden test (`edits.golden.test.ts`) calls `upsertKeyframe(track, t_us, value)` and ignores ids — still passes.

- [ ] **Step 2: Run the golden + renderer keyframe tests to confirm no regression.**

Run: `cd apps/desktop && npx vitest run src/renderer/keyframe`
Expected: PASS (golden + edits tests green; the signature change is additive).

- [ ] **Step 3: Create the main-process re-export `keyframeEdits.ts`.**

Create `apps/desktop/src/main/state/keyframeEdits.ts`:

```typescript
// The keyframe-edit algorithms the MCP keyframe tools use MUST be the renderer's
// golden-tested module (src/renderer/keyframe/edits.ts) — never a reimplementation
// — so TS-in-main and the Rust `keyframe_edits.rs` algorithms stay in lockstep
// (same rationale as snap.ts re-exporting the wasm eval leaf). The MCP path
// injects the actor's deterministic idGen as `mkId` so new keyframe ids match
// Rust `new_id()` allocation order under det mode. Phase-4 view-type unification
// debt: this crosses the project boundary like summary.ts's view types.
export {
  liftToKeyframed,
  upsertKeyframe,
  removeKeyframe,
  retimeKeyframe,
  setKeyframeInterp,
  smoothKeyframe,
  smoothTrack,
} from '../../renderer/keyframe/edits'
```

- [ ] **Step 4: Add the `resolveAnimatedF64` reader + `readLayerTrack` to `params.ts`.**

In `apps/desktop/src/main/state/mutations/params.ts`, after `f64Lens` (ends line 143), add:

```typescript
/** layer.rs:286-374 read sibling of f64Lens — resolve a param-key to its CURRENT
 *  Animated<f64> (a reference into the layer), or null if unknown/invalid on this
 *  kind. Effect-param paths read layer.effects (None when the param slot is
 *  absent → caller maps to UnknownKeyframeParam). Read-only: never inserts. */
export function resolveAnimatedF64(layer: Layer, key: string): Animated<number> | null {
  const eff = parseEffectParamKey(key)
  if (eff) {
    const e = layer.effects.find((x) => x.id === eff[0])
    return e ? (e.params[eff[1]] ?? null) : null
  }
  const p = layer.params
  if (p.kind === 'Color') return null
  if (p.kind === 'Audio') {
    if (key === 'gain_db') return p.gain_db
    if (key === 'pan') return p.pan
    return null
  }
  // VideoClip | ImageOverlay | Text | Motif — transform + opacity
  if (key === 'opacity') return p.opacity
  if (TRANSFORM_F64_KEYS.includes(key)) return (p.transform as unknown as Record<string, Animated<number>>)[key] ?? null
  return null
}

/** native/src/mcp/keyframes.rs:126 read_track — locate the layer (LayerNotFound),
 *  resolve the param key (UnknownKeyframeParam), return its t_start_us + current
 *  track. Used by the MCP keyframe tools for timeline-absolute↔layer-local
 *  conversion. Read-only (no commit, no id mint). */
export function readLayerTrack(p: Project, id: Uuid, paramKey: string): { tStartUs: number; track: Animated<number> } {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const layer = p.tracks[loc[0]].layers[loc[1]]
  const track = resolveAnimatedF64(layer, paramKey)
  if (track === null) throw new CommandFailure({ error: 'UnknownKeyframeParam', layer: id, param_key: paramKey })
  return { tStartUs: layer.t_start_us, track }
}
```

(`Layer` and `Project` are already imported in params.ts line 1; `CommandFailure` line 2; `locateLayer` line 4; `parseEffectParamKey`/`TRANSFORM_F64_KEYS` are defined in this file.)

- [ ] **Step 5: Write the `readLayerTrack` unit test.**

Create `apps/desktop/src/main/state/mutations/params.readtrack.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor } from '../actor'
import { readLayerTrack, resolveAnimatedF64 } from './params'

function colorLayerProject() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't')
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const aRoll = initial.tracks[0].id
  const r = actor.dispatch('add_layer', { kind: 'color', track: aRoll, t_start_us: 500000, t_end_us: 1500000 })
  return { proj: actor.snapshot(), layerId: r.ok ? (r.value as string) : '' }
}

describe('readLayerTrack', () => {
  it('LayerNotFound for an unknown layer id', () => {
    const { proj } = colorLayerProject()
    expect(() => readLayerTrack(proj, '00000000-0000-0000-0000-0000000000ff', 'opacity')).toThrow(/LayerNotFound|Layer/)
  })
  it('UnknownKeyframeParam for a Color layer (no animatable params)', () => {
    const { proj, layerId } = colorLayerProject()
    expect(() => readLayerTrack(proj, layerId, 'opacity')).toThrow(/UnknownKeyframeParam|Unknown/)
  })
  it('resolveAnimatedF64 returns null for Color opacity', () => {
    const { proj, layerId } = colorLayerProject()
    const loc = proj.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)!
    expect(resolveAnimatedF64(loc, 'opacity')).toBeNull()
  })
})
```

(Note: the error thrown is a `CommandFailure` whose `.message`/`.err` carries the variant — the regex matches the variant tag. If `CommandFailure.message` is not the variant string, assert on the thrown `.err.error` instead: wrap in `try/catch` and `expect(e.err.error).toBe('LayerNotFound')`. Check `errors.ts` `CommandFailure` shape and adjust the assertion to whichever field holds the variant.)

- [ ] **Step 6: Run the test + state suite + typecheck (the boundary de-risk).**

Run:
```bash
cd apps/desktop && npx vitest run src/main/state/mutations/params.readtrack.test.ts && npx vitest run src/main/state && npx tsc -b
```
Expected: all green. **`tsc -b` is the critical check** — it proves main can import `edits.ts` (transitively `curve`/`render/animated`/`eval`, all DOM-free like `snap.ts`) and that `crypto.randomUUID` in `edits.ts`'s `newId` default type-checks in main's program. **If `tsc -b` fails on a DOM/`crypto` type in `edits.ts`** (unlikely — `@types/node` provides the global `crypto`), the fallback is to give `newId`'s default a node-safe form: `const newId = (): string => (globalThis.crypto as { randomUUID(): string }).randomUUID()` (keeps the renderer working, satisfies main's types). Apply only if needed.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/renderer/keyframe/edits.ts apps/desktop/src/main/state/keyframeEdits.ts apps/desktop/src/main/state/mutations/params.ts apps/desktop/src/main/state/mutations/params.readtrack.test.ts
git commit -m "feat(state-migration): keyframe-edit boundary re-export + readLayerTrack reader (Phase 3d-b)"
```

---

### Task 2: `set_keyframe` + `get_param_track` + harness keyframe-id capture + gate

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (`mcpCall` switch — add `set_keyframe`/`get_param_track` arms; imports)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (`shapeGetParamTrack`; `MCP_TOOLS` additions)
- Modify: `apps/desktop/src/main/state/replay.ts` (`resolveWire` skip `kf_index`; `mcpRefId` get_param_track capture)
- Modify: `apps/desktop/native/src/bin/mcp_driver.rs` (`build_args` skip `kf_index`; `extract_ref_id` get_param_track capture)
- Create: `apps/desktop/fixtures/state-corpus/sequences-mcp/set-keyframe.json` (+ generated oracle)
- Test: `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts` (reused)

**Interfaces:**
- Consumes: `readLayerTrack`/`resolveAnimatedF64` (Task 1), `upsertKeyframe` (keyframeEdits), `dispatch('update_layer_param_track')`, `toolJson`/`toolEmpty`/`parseUuid` (mcp-commands), `current()`, `idGen`.
- Produces: `mcpCall` arms for `set_keyframe`/`get_param_track`; `shapeGetParamTrack(track, tStartUs): unknown`; `MCP_TOOLS` += `{set_keyframe, get_param_track}`; the `kf_index` capture convention in both drivers.

- [ ] **Step 1: Add imports to `actor.ts`.** Add near the existing `./mcp-commands` import (actor.ts ~line for the 3d-a import block):

```typescript
import { upsertKeyframe, removeKeyframe, retimeKeyframe, setKeyframeInterp, smoothKeyframe, smoothTrack } from './keyframeEdits'
import { readLayerTrack } from './mutations/params'
import { shapeGetParamTrack } from './mcp-commands'
```
And ensure `Interpolation` is importable from `./model` (it is exported there). Add it to the existing `./model` type import if not already present.

- [ ] **Step 2: Add `shapeGetParamTrack` to `mcp-commands.ts`.** After `toolJson` (line 32), add:

```typescript
/** native/src/mcp/keyframes.rs:165 get_param_track result shape (NOT the raw
 *  Animated serde): Static → {mode,value}; Keyframed → {mode, keyframes:[{id,
 *  t_us (timeline-absolute = local + t_start), t_local_us (stored base), value,
 *  interp}]}. Caller wraps in toolJson (sorted keys, mirrors Rust json!/BTreeMap). */
export function shapeGetParamTrack(track: { mode: 'Static'; value: number } | { mode: 'Keyframed'; value: Array<{ id: string; t_us: number; value: number; interp: unknown }> }, tStartUs: number): unknown {
  if (track.mode === 'Static') return { mode: 'Static', value: track.value }
  return {
    mode: 'Keyframed',
    keyframes: track.value.map((k) => ({ id: k.id, t_us: k.t_us + tStartUs, t_local_us: k.t_us, value: k.value, interp: k.interp })),
  }
}
```

- [ ] **Step 3: Add the `set_keyframe` + `get_param_track` arms** in `actor.ts` `mcpCall`'s `switch (name)` block (after the existing `case 'unlock_history':`, before the block closes at line 605):

```typescript
        case 'set_keyframe': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const paramKey = a.param_key as string
          const { tStartUs, track } = readLayerTrack(current(), layer, paramKey)
          const interp = a.interp as Interpolation | undefined
          const next = upsertKeyframe(track, (a.t_us as number) - tStartUs, a.value as number, interp, idGen)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'get_param_track': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const paramKey = a.param_key as string
          const { tStartUs, track } = readLayerTrack(current(), layer, paramKey)
          return { ok: true, result: toolJson(shapeGetParamTrack(track, tStartUs)) }
        }
```

(`readLayerTrack` throws `CommandFailure(LayerNotFound|UnknownKeyframeParam)` → caught by the existing `mcpCall` catch → `mapCommandError` → `invalid_params`. `upsertKeyframe(..., idGen)` mints the keyframe id from the actor's seeded gen BEFORE `dispatch` mints the op_id — the id contract. `toolJson` is already imported in actor.ts from 3d-a; confirm and add if missing.)

- [ ] **Step 4: Extend `MCP_TOOLS`** in `mcp-commands.ts`. Change the `Set` literal (lines 106-116) to append the keyframe + dry_run tools:

```typescript
export const MCP_TOOLS: ReadonlySet<string> = new Set<string>([
  'add_track', 'remove_track', 'move_track',
  'add_color_layer', 'add_video_layer', 'update_layer', 'update_layer_params',
  'move_layer', 'split_layer', 'delete_layer', 'trim_layer', 'duplicate_layer',
  'groups_create', 'groups_dissolve', 'groups_add_members', 'groups_remove_members', 'groups_rename',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'set_composition', 'fit_composition_to_layers',
  'add_marker', 'update_marker', 'remove_marker',
  'remove_media', 'undo', 'redo', 'lock_history', 'unlock_history',
  'set_role_gain', 'set_role_flags',
  // Phase 3d-b: keyframes + dry_run
  'set_keyframe', 'get_param_track', 'remove_keyframe', 'retime_keyframe',
  'set_keyframe_easing', 'smooth_keyframes', 'clear_keyframes', 'set_param_track', 'dry_run',
])
```
(All 9 are added now so `mcpSequenceIsSupported` doesn't silently skip a Task-3/4 sequence; the arms for the rest land in Tasks 3-4. Until then a sequence using an unimplemented tool would fail the gate, not skip — which is the intended "fail loudly" behavior.)

- [ ] **Step 5: Add the `kf_index` capture convention to `mcp_driver.rs`.**

In `apps/desktop/native/src/bin/mcp_driver.rs`:
1. In `build_args` (line 61), change the skip condition to also skip `kf_index`:
```rust
            if k == "op" || k == "ref" || k == "kf_index" { continue; }
```
2. Change the `extract_ref_id` call site (line 42) to pass `cmd`:
```rust
            let ret = if ok { extract_ref_id(&op, &env["result"], cmd) } else { None };
```
3. Replace `extract_ref_id` (lines 81-94) with the `get_param_track` capture added:
```rust
/// Extract the @ref id from an MCP result envelope's `result` value, by tool.
/// id tools → result.content[0].text is the raw UUID. add_video_layer → the
/// inner JSON's "video_layer_id". get_param_track → keyframes[cmd.kf_index].id
/// (so a sequence can name a server-minted keyframe id). Others → None.
fn extract_ref_id(op: &str, result: &Value, cmd: &Value) -> Option<String> {
    let text = result.get("content")?.get(0)?.get("text")?.as_str()?;
    match op {
        "add_track" | "add_color_layer" | "duplicate_layer" | "groups_create"
        | "add_effect" | "add_marker" => Some(text.to_string()),
        "add_video_layer" => {
            serde_json::from_str::<Value>(text).ok()
                .and_then(|v| v.get("video_layer_id").and_then(Value::as_str).map(str::to_string))
                .or_else(|| Some(text.to_string()))
        }
        "get_param_track" => {
            let idx = cmd.get("kf_index")?.as_u64()? as usize;
            let v: Value = serde_json::from_str(text).ok()?;
            v.get("keyframes")?.get(idx)?.get("id")?.as_str().map(str::to_string)
        }
        _ => None,
    }
}
```

- [ ] **Step 6: Add the symmetric `kf_index` capture to `replay.ts`.**

In `apps/desktop/src/main/state/replay.ts`:
1. In `resolveWire` (line 180), skip `kf_index` too:
```typescript
    if (k === 'op' || k === 'ref' || k === 'kf_index') continue
```
2. Change the `mcpRefId` call site in `replayMcpSequence` (line 212) to pass `cmd`:
```typescript
      if (r.ok) ret = mcpRefId(cmd.op, r.result, cmd)
```
3. Replace `mcpRefId` (lines 220-229) with the get_param_track capture:
```typescript
/** @ref extraction mirroring mcp_driver::extract_ref_id. get_param_track captures
 *  keyframes[cmd.kf_index].id so a sequence can name a server-minted keyframe. */
function mcpRefId(op: string, result: { content: Array<{ type: 'text'; text: string }> }, cmd: Cmd): string | null {
  const text = result.content[0]?.text
  if (text == null) return null
  if (op === 'get_param_track') {
    const idx = cmd.kf_index as number | undefined
    if (idx == null) return null
    try { const v = JSON.parse(text) as { keyframes?: Array<{ id?: string }> }; return v.keyframes?.[idx]?.id ?? null } catch { return null }
  }
  if (['add_track', 'add_color_layer', 'duplicate_layer', 'groups_create', 'add_effect', 'add_marker'].includes(op)) return text
  if (op === 'add_video_layer') {
    try { const v = JSON.parse(text) as { video_layer_id?: string }; return v.video_layer_id ?? text } catch { return text }
  }
  return null
}
```

- [ ] **Step 7: Write the `set-keyframe` sequence.** `apps/desktop/fixtures/state-corpus/sequences-mcp/set-keyframe.json`:

```json
{ "name": "set-keyframe", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000b1", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 1000000, "t_end_us": 4000000, "src_in_us": 0, "src_out_us": 3000000, "ref": "VL" },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "opacity", "t_us": 1000000, "value": 0.0 },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "opacity", "t_us": 2500000, "value": 1.0, "interp": { "kind": "Bezier", "p1": [0.42, 0.0], "p2": [0.58, 1.0] } },
  { "op": "get_param_track", "layer_id": "@VL", "param_key": "opacity" }
]}
```

This gates: Static→Keyframed lift (1st set_keyframe, layer-local `1000000-1000000=0`), insert with explicit Bezier interp (2nd, layer-local `2500000-1000000=1500000`), the keyframe-id allocation order (the keyframe id minted before each op_id — revealed in state), and `get_param_track`'s absolute/local time reporting (`t_us` 1000000 & 2500000, `t_local_us` 0 & 1500000). The video has no audio (`with_audio` omitted → false) so `add_video_layer` does NOT auto-pair.

- [ ] **Step 8: Regenerate and gate.**

Run (from `apps/desktop`, toolchain env exported):
```bash
node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts
```
Expected: prints `ok  mcp/set-keyframe.json`; the gate passes for `set-keyframe`. **If the per-step `state` diverges**, the most likely cause is the keyframe-id allocation order — confirm `upsertKeyframe` mints via `idGen` (NOT `crypto.randomUUID`) and BEFORE `dispatch`; the trailing keyframe ids in `state` reveal the order. **If `env.result` diverges for `get_param_track`**, compare the `keyframes[*]` shape — Rust emits `t_us`/`t_local_us`/`id`/`value`/`interp`; ensure `shapeGetParamTrack` matches and `toolJson` sorts keys.

- [ ] **Step 9: Confirm additivity, run state suite + typecheck, commit.**

```bash
cd apps/desktop && git -C ../.. status --short apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod apps/desktop/fixtures/state-corpus/oracle-mcp
```
Expected: only NEW `oracle-mcp/set-keyframe.json` (no pre-existing oracle modified). Then:
```bash
npx vitest run src/main/state && npx tsc -b
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/replay.ts apps/desktop/native/src/bin/mcp_driver.rs apps/desktop/fixtures/state-corpus/sequences-mcp/set-keyframe.json apps/desktop/fixtures/state-corpus/oracle-mcp/set-keyframe.json
git commit -m "feat(state-migration): MCP set_keyframe + get_param_track + kf-id capture, gated (Phase 3d-b)"
```

---

### Task 3: keyframe-id-consuming + collapse tools (`remove`/`retime`/`set_keyframe_easing`/`smooth_keyframes`/`clear_keyframes`/`set_param_track`)

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (`mcpCall` switch — add 6 arms)
- Create sequences: `remove-keyframe.json`, `retime-keyframe.json`, `set-keyframe-easing.json`, `smooth-keyframes.json`, `clear-keyframes.json`, `set-param-track.json`, `err-keyframe-not-found.json`, `clear-keyframes-noop.json` (+ generated oracles)
- Test: `mcp.differential.test.ts` (reused)

**Interfaces:**
- Consumes: `removeKeyframe`/`retimeKeyframe`/`setKeyframeInterp`/`smoothKeyframe`/`smoothTrack` (keyframeEdits), `readLayerTrack`, `dispatch('update_layer_param_track')`, `McpArgError` (already imported in actor.ts), `parseUuid`.
- Produces: `mcpCall` arms for the 6 tools.

- [ ] **Step 1: Add the 6 arms** in `actor.ts` `mcpCall`'s `switch (name)` block (after the `get_param_track` arm from Task 2):

```typescript
        case 'remove_keyframe': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const keyframeId = parseUuid(a.keyframe_id, 'keyframe_id')
          const paramKey = a.param_key as string
          const { track } = readLayerTrack(current(), layer, paramKey)
          if (!keyframePresent(track, keyframeId)) throw new McpArgError(`keyframe ${keyframeId} not found on layer ${layer} param '${paramKey}'`)
          const fallback = track.mode === 'Static' ? track.value : (track.value[0]?.value ?? 0)
          const next = removeKeyframe(track, keyframeId, fallback)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'retime_keyframe': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const keyframeId = parseUuid(a.keyframe_id, 'keyframe_id')
          const paramKey = a.param_key as string
          const { tStartUs, track } = readLayerTrack(current(), layer, paramKey)
          if (!keyframePresent(track, keyframeId)) throw new McpArgError(`keyframe ${keyframeId} not found on layer ${layer} param '${paramKey}'`)
          const next = retimeKeyframe(track, keyframeId, (a.t_us as number) - tStartUs)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'set_keyframe_easing': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const keyframeId = parseUuid(a.keyframe_id, 'keyframe_id')
          const paramKey = a.param_key as string
          const { track } = readLayerTrack(current(), layer, paramKey)
          if (!keyframePresent(track, keyframeId)) throw new McpArgError(`keyframe ${keyframeId} not found on layer ${layer} param '${paramKey}'`)
          const next = setKeyframeInterp(track, keyframeId, a.interp as Interpolation)
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'smooth_keyframes': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const paramKey = a.param_key as string
          const { track } = readLayerTrack(current(), layer, paramKey)
          const keyframeId = a.keyframe_id != null ? parseUuid(a.keyframe_id, 'keyframe_id') : null
          let next
          if (keyframeId !== null) {
            if (!keyframePresent(track, keyframeId)) throw new McpArgError(`keyframe ${keyframeId} not found on layer ${layer} param '${paramKey}'`)
            next = smoothKeyframe(track, keyframeId)
          } else {
            next = smoothTrack(track)
          }
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: next })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'clear_keyframes': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const paramKey = a.param_key as string
          const { track } = readLayerTrack(current(), layer, paramKey)
          if (track.mode === 'Static') return { ok: true, result: toolEmpty() } // no-op, no commit (keyframes.rs:294)
          const value = (a.value as number | undefined) ?? track.value[0]?.value ?? 0
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: { mode: 'Static', value } })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
        case 'set_param_track': {
          const layer = parseUuid(a.layer_id, 'layer_id')
          const paramKey = a.param_key as string
          const { tStartUs } = readLayerTrack(current(), layer, paramKey) // validate layer+param; current discarded
          const input = a.track as Animated<number>
          const shifted: Animated<number> = input.mode === 'Keyframed'
            ? { mode: 'Keyframed', value: input.value.map((k) => ({ ...k, t_us: k.t_us - tStartUs })) }
            : input
          const r = dispatch('update_layer_param_track', { layer, param_key: paramKey, track: shifted })
          if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
          return { ok: true, result: toolEmpty() }
        }
```

Add the local helper `keyframePresent` near the top of `createActor` (or as a module-level pure fn in `mcp-commands.ts` imported here — module-level is cleaner). **Decision: add to `mcp-commands.ts`** and import it:

```typescript
// mcp-commands.ts — keyframes.rs:149 require_key presence check (the caller throws McpArgError on false).
export function keyframePresent(track: { mode: string; value: unknown }, id: string): boolean {
  return track.mode === 'Keyframed' && Array.isArray((track as { value: Array<{ id: string }> }).value)
    && (track as { value: Array<{ id: string }> }).value.some((k) => k.id === id)
}
```
Import `keyframePresent` in actor.ts alongside the other `./mcp-commands` imports. `Animated` must be imported in actor.ts (it already is — used by `update_layer_param_track` dispatch arm at line 360).

- [ ] **Step 2: Write the sequences.** Each uses a no-audio video layer (animatable VideoClip params) created at a non-zero `t_start_us` to gate time conversion. The id-consuming tools read the keyframe id back via `get_param_track` + `kf_index`.

`sequences-mcp/remove-keyframe.json`:
```json
{ "name": "remove-keyframe", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000c1", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 1000000, "t_end_us": 4000000, "src_in_us": 0, "src_out_us": 3000000, "ref": "VL" },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "x", "t_us": 1000000, "value": 0.0 },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "x", "t_us": 3000000, "value": 100.0 },
  { "op": "get_param_track", "layer_id": "@VL", "param_key": "x", "ref": "K0", "kf_index": 0 },
  { "op": "remove_keyframe", "layer_id": "@VL", "param_key": "x", "keyframe_id": "@K0" }
]}
```

`sequences-mcp/retime-keyframe.json`: same setup, final op:
```json
  { "op": "retime_keyframe", "layer_id": "@VL", "param_key": "x", "keyframe_id": "@K0", "t_us": 3500000 }
```
(replace the `remove_keyframe` line with this; keep the `get_param_track` capture line.)

`sequences-mcp/set-keyframe-easing.json`: same setup, final op:
```json
  { "op": "set_keyframe_easing", "layer_id": "@VL", "param_key": "x", "keyframe_id": "@K0", "interp": { "kind": "EaseIn" } }
```

`sequences-mcp/smooth-keyframes.json` (3 keys, whole-track smooth — no keyframe_id):
```json
{ "name": "smooth-keyframes", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000c2", "kind": "Video", "duration_us": 6000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 0, "t_end_us": 6000000, "src_in_us": 0, "src_out_us": 6000000, "ref": "VL" },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "y", "t_us": 0, "value": 0.0 },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "y", "t_us": 2000000, "value": 50.0 },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "y", "t_us": 4000000, "value": 0.0 },
  { "op": "smooth_keyframes", "layer_id": "@VL", "param_key": "y" }
]}
```
(Also add `smooth-keyframes-one.json` — same setup but capture `kf_index: 1` as `@K1` and `smooth_keyframes` with `keyframe_id: "@K1"` to gate the single-key path + require_key.)

`sequences-mcp/clear-keyframes.json` (2 keys → clear with explicit value):
```json
{ "name": "clear-keyframes", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000c3", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 0, "t_end_us": 5000000, "src_in_us": 0, "src_out_us": 5000000, "ref": "VL" },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "opacity", "t_us": 0, "value": 0.2 },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "opacity", "t_us": 2000000, "value": 0.8 },
  { "op": "clear_keyframes", "layer_id": "@VL", "param_key": "opacity", "value": 0.5 }
]}
```

`sequences-mcp/clear-keyframes-noop.json` (clear on an already-Static param → no commit, no id burn — proven by a trailing `add_marker` whose id is unchanged):
```json
{ "name": "clear-keyframes-noop", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000c4", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 0, "t_end_us": 5000000, "src_in_us": 0, "src_out_us": 5000000, "ref": "VL" },
  { "op": "clear_keyframes", "layer_id": "@VL", "param_key": "opacity" },
  { "op": "add_marker", "t_us": 0, "label": "m", "color": { "r": 0, "g": 128, "b": 255, "a": 255 } }
]}
```

`sequences-mcp/set-param-track.json` (bulk replace — input is the RAW Animated serde with timeline-absolute `t_us`; the layer's `t_start_us` is 1000000 so each key shifts to local):
```json
{ "name": "set-param-track", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000c5", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 1000000, "t_end_us": 4000000, "src_in_us": 0, "src_out_us": 3000000, "ref": "VL" },
  { "op": "set_param_track", "layer_id": "@VL", "param_key": "scale_x", "track": { "mode": "Keyframed", "value": [
    { "id": "00000000-0000-0000-0000-0000000000d1", "t_us": 1000000, "value": 1.0, "interp": { "kind": "Linear" } },
    { "id": "00000000-0000-0000-0000-0000000000d2", "t_us": 3000000, "value": 2.0, "interp": { "kind": "Hold" } }
  ] } }
]}
```
(The keyframe ids in `set_param_track`'s input are caller LITERALS — they survive into state; this gates the time-shift `t_us - t_start` and the pass-through of client ids/interp.)

`sequences-mcp/err-keyframe-not-found.json` (KeyframeNotFound → invalid_params, no data; the bogus id is a literal that exists on neither engine):
```json
{ "name": "err-keyframe-not-found", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000c6", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 0, "t_end_us": 5000000, "src_in_us": 0, "src_out_us": 5000000, "ref": "VL" },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "x", "t_us": 0, "value": 0.0 },
  { "op": "remove_keyframe", "layer_id": "@VL", "param_key": "x", "keyframe_id": "00000000-0000-0000-0000-0000000000ee" }
]}
```

- [ ] **Step 3: Regen + gate.**

Run: `cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts`
Expected: all new sequences pass. **Common fix points:** (a) `smooth_keyframes` Bezier coeffs — `edits.ts` `smoothKeyframe` uses `interpToCoeffs` from `./curve`; if a Bezier value diverges at the last decimal, confirm the renderer algorithm is byte-for-byte the one Rust `keyframe_edits::smooth_one` mirrors (the `edits.golden.test.ts` already pins this to 1e-9 — but the differential asserts EXACT serialized f64, so a `smooth` divergence would surface here; if it does, it is a pre-existing renderer↔Rust drift to flag, not a 3d-b bug — STOP and report). (b) `clear-keyframes-noop` trailing `add_marker` id must be unchanged vs a no-clear baseline (proves no commit on the Static no-op). (c) `set_param_track` keyframe `t_us` in state must be layer-local (input 1000000/3000000 → stored 0/2000000 after `-t_start` and frame-snap).

- [ ] **Step 4: Full suite + typecheck + commit.**

```bash
cd apps/desktop && npx vitest run src/main/state && npx tsc -b
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mcp-commands.ts apps/desktop/fixtures/state-corpus/sequences-mcp/ apps/desktop/fixtures/state-corpus/oracle-mcp/
git commit -m "feat(state-migration): MCP keyframe edit + collapse tools, gated (Phase 3d-b)"
```

---

### Task 4: `dry_run` — extend `DryRunOp`/`DryRunOutput` + `dryRun`, spec parse, response shape

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (`DryRunOp`/`DryRunOutput` types; `dryRun` switch; `mcpCall` `dry_run` arm)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (`shapeDryRunResponse`; `dryRunErrorString`)
- Create: `apps/desktop/src/main/state/__tests__/mcp.dryrun.test.ts` (TS-only halt/error unit gate)
- Create sequences: `dry-run-add.json`, `dry-run-split.json`, `dry-run-void.json` (+ generated oracles)
- Test: `mcp.differential.test.ts` (reused) + the new unit test

**Interfaces:**
- Consumes: `applyAddLayer`/`applyDeleteLayer`/`applyMoveLayer`/`applyTrimLayer`/`applyUpdateLayer`/`applyUpdateLayerParams`/`applySplitLayer` (all already imported in actor.ts), `colorParams`/`videoClipParams`, `runValidate`, `produce`, `parseUuid`, `LayerPatch`/`LayerParamsPatch`.
- Produces: extended `DryRunOp`/`DryRunOutput`; `mcpCall` `dry_run` arm; `shapeDryRunResponse(results): ToolResultJson`.

- [ ] **Step 1: Extend `DryRunOp` + `DryRunOutput`** (actor.ts lines 39-44):

```typescript
export type DryRunOp =
  | { kind: 'AddLayer'; track_id: Uuid; params: LayerParams; t_start_us: number; t_end_us: number }
  | { kind: 'DeleteLayer'; id: Uuid }
  | { kind: 'UpdateLayer'; id: Uuid; patch: LayerPatch }
  | { kind: 'UpdateLayerParams'; id: Uuid; patch: LayerParamsPatch }
  | { kind: 'MoveLayer'; id: Uuid; new_track_id: Uuid; new_t_start_us: number; escape_group: boolean }
  | { kind: 'SplitLayer'; id: Uuid; at_t_us: number; escape_group: boolean }
  | { kind: 'TrimLayer'; id: Uuid; edge: LayerEdge; new_t_us: number; escape_group: boolean }
export type DryRunOutput =
  | { kind: 'AddLayer'; layer_id: Uuid }
  | { kind: 'SplitLayer'; left_id: Uuid; right_id: Uuid }
  | { kind: 'Void' }
```

- [ ] **Step 2: Extend the `dryRun` switch** (actor.ts lines 307-312) to the 3 new op kinds:

```typescript
          switch (op.kind) {
            case 'AddLayer': value = { kind: 'AddLayer', layer_id: applyAddLayer(d, idGen, op.track_id, op.params, op.t_start_us, op.t_end_us) }; break
            case 'DeleteLayer': applyDeleteLayer(d, op.id); break
            case 'UpdateLayer': applyUpdateLayer(d, op.id, op.patch); break
            case 'UpdateLayerParams': applyUpdateLayerParams(d, op.id, op.patch); break
            case 'MoveLayer': applyMoveLayer(d, op.id, op.new_track_id, op.new_t_start_us, op.escape_group); break
            case 'SplitLayer': { const s = applySplitLayer(d, idGen, op.id, op.at_t_us, op.escape_group); value = { kind: 'SplitLayer', left_id: s.left, right_id: s.right }; break }
            case 'TrimLayer': applyTrimLayer(d, op.id, op.edge, op.new_t_us, op.escape_group); break
          }
```

(`applyUpdateLayer`/`applyUpdateLayerParams`/`applySplitLayer` are already imported in actor.ts — confirm; `applySplitLayer` returns `{ left, right }` per `mutations/split.ts`.)

- [ ] **Step 3: Add `shapeDryRunResponse` + `dryRunErrorString` to `mcp-commands.ts`.**

```typescript
import type { CommandError } from './errors'   // (already imported at top)

/** Reasonable, NON-asserted prose for a failed dry-run op (the differential
 *  gate uses succeeding-ops-only sequences, so this string is never gated;
 *  the halt/error shape is unit-tested in mcp.dryrun.test.ts). */
export function dryRunErrorString(e: CommandError): string {
  if (e.error === 'InvalidArgument') return `${e.field}: ${e.detail}`
  if (e.error === 'Backend') return e.detail
  if (e.error === 'ValidationFailed') return `validation failed: ${e.detail.rule}`
  return e.error
}

/** tools.rs:1512 DryRunResponse: per-op {index, status, output|error} flattened,
 *  plus halted_at (the first failing index, or null). DryRunOutput serde is
 *  tag="kind" rename_all=snake_case: add_layer{layer_id} / split_layer{left_id,
 *  right_id} / void. Wrapped in toolJson (sorted keys). */
export function shapeDryRunResponse(
  results: Array<{ ok: true; value: { kind: 'AddLayer'; layer_id: string } | { kind: 'SplitLayer'; left_id: string; right_id: string } | { kind: 'Void' } } | { ok: false; error: CommandError }>,
): ToolResultJson {
  let haltedAt: number | null = null
  const entries = results.map((r, index) => {
    if (r.ok) {
      const o = r.value
      const output = o.kind === 'AddLayer' ? { kind: 'add_layer', layer_id: o.layer_id }
        : o.kind === 'SplitLayer' ? { kind: 'split_layer', left_id: o.left_id, right_id: o.right_id }
        : { kind: 'void' }
      return { index, status: 'ok', output }
    }
    if (haltedAt === null) haltedAt = index
    return { index, status: 'error', error: dryRunErrorString(r.error) }
  })
  return toolJson({ results: entries, halted_at: haltedAt })
}
```

- [ ] **Step 4: Add the `dry_run` arm** to `actor.ts` `mcpCall`'s `switch (name)` (after the keyframe arms). It parses `OperationSpec[]` → `DryRunOp[]`, calls `dryRun`, shapes the response:

```typescript
        case 'dry_run': {
          const specs = (a.operations as Array<Record<string, unknown>>) ?? []
          const ops: DryRunOp[] = []
          for (let i = 0; i < specs.length; i++) {
            try { ops.push(specToDryRunOp(specs[i])) }
            catch (e) {
              if (e instanceof McpArgError) return { ok: false, error: { code: 'invalid_params', message: `operations[${i}]: ${e.mcpMessage}` } }
              throw e
            }
          }
          return { ok: true, result: shapeDryRunResponse(dryRun(ops)) }
        }
```

And add a module-scoped (inside `createActor`, so it can reach `colorParams`/`videoClipParams`) helper `specToDryRunOp` just above `mcpCall`:

```typescript
  // tools.rs:1563 spec_to_op — MCP OperationSpec (tagged "kind", snake_case) → DryRunOp.
  function specToDryRunOp(spec: Record<string, unknown>): DryRunOp {
    const kind = spec.kind as string
    switch (kind) {
      case 'add_color_layer':
        return { kind: 'AddLayer', track_id: parseUuid(spec.track_id, 'track_id'),
          params: colorParams(spec.color as Rgba, (spec.width as number | undefined) ?? 1920, (spec.height as number | undefined) ?? 1080),
          t_start_us: spec.t_start_us as number, t_end_us: spec.t_end_us as number }
      case 'add_video_layer':
        return { kind: 'AddLayer', track_id: parseUuid(spec.track_id, 'track_id'),
          params: videoClipParams(parseUuid(spec.media_id, 'media_id'), spec.src_in_us as number, spec.src_out_us as number),
          t_start_us: spec.t_start_us as number, t_end_us: spec.t_end_us as number }
      case 'update_layer':
        return { kind: 'UpdateLayer', id: parseUuid(spec.layer_id, 'layer_id'), patch: spec.patch as LayerPatch }
      case 'update_layer_params':
        return { kind: 'UpdateLayerParams', id: parseUuid(spec.layer_id, 'layer_id'), patch: spec.patch as LayerParamsPatch }
      case 'move_layer':
        return { kind: 'MoveLayer', id: parseUuid(spec.layer_id, 'layer_id'), new_track_id: parseUuid(spec.new_track_id, 'new_track_id'), new_t_start_us: spec.new_t_start_us as number, escape_group: (spec.escape_group as boolean) ?? false }
      case 'split_layer':
        return { kind: 'SplitLayer', id: parseUuid(spec.layer_id, 'layer_id'), at_t_us: spec.at_t_us as number, escape_group: (spec.escape_group as boolean) ?? false }
      case 'delete_layer':
        return { kind: 'DeleteLayer', id: parseUuid(spec.layer_id, 'layer_id') }
      default:
        throw new McpArgError(`unknown operation kind '${kind}'`)
    }
  }
```

Import `shapeDryRunResponse` from `./mcp-commands` and `LayerPatch` from the appropriate mutations module (it is already imported in actor.ts at the `update_layer` dispatch arm — confirm; `LayerParamsPatch`/`Rgba` are also already imported).

- [ ] **Step 5: Write the differential sequences (succeeding ops only).**

`sequences-mcp/dry-run-add.json` (real layer setup, then a dry_run AddLayer that succeeds; trailing `add_color_layer` reveals the det-counter advance from the dry-run mint):
```json
{ "name": "dry-run-add", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 0, "t_end_us": 1000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 }, "ref": "L1" },
  { "op": "dry_run", "operations": [
    { "kind": "add_color_layer", "track_id": "@B", "t_start_us": 0, "t_end_us": 1000000, "color": { "r": 1, "g": 2, "b": 3, "a": 255 } }
  ] },
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 2000000, "t_end_us": 3000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 } }
]}
```

`sequences-mcp/dry-run-split.json`:
```json
{ "name": "dry-run-split", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 0, "t_end_us": 4000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 }, "ref": "L1" },
  { "op": "dry_run", "operations": [
    { "kind": "split_layer", "layer_id": "@L1", "at_t_us": 2000000 }
  ] },
  { "op": "add_color_layer", "track_id": "@B", "t_start_us": 0, "t_end_us": 1000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 } }
]}
```

`sequences-mcp/dry-run-void.json` (UpdateLayer + UpdateLayerParams + MoveLayer + DeleteLayer — all void, sequenced so each succeeds against the clone; delete LAST):
```json
{ "name": "dry-run-void", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 0, "t_end_us": 1000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 }, "ref": "L1" },
  { "op": "dry_run", "operations": [
    { "kind": "update_layer", "layer_id": "@L1", "patch": { "label": "x" } },
    { "kind": "update_layer_params", "layer_id": "@L1", "patch": { "kind": "Color", "width": 640 } },
    { "kind": "move_layer", "layer_id": "@L1", "new_track_id": "@B", "new_t_start_us": 0 },
    { "kind": "delete_layer", "layer_id": "@L1" }
  ] },
  { "op": "add_color_layer", "track_id": "@A", "t_start_us": 2000000, "t_end_us": 3000000, "color": { "r": 0, "g": 0, "b": 0, "a": 255 } }
]}
```

(All dry_run ops succeed → `halted_at:null`, every result `status:"ok"`. The `update_layer` patch shape `{label}` matches `LayerPatch`; `update_layer_params` `{kind:"Color",width}` matches `LayerParamsPatch`. Each sequence's trailing real `add_color_layer` gates that the dry-run consumed the SAME number of det ids on both engines — `dry-run-add`/`dry-run-split` mint inside the dry run; `dry-run-void` mints none, so its trailing id must equal the no-dry-run baseline offset.)

- [ ] **Step 6: Write the TS-only halt/error unit gate** `apps/desktop/src/main/state/__tests__/mcp.dryrun.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor } from '../actor'

function actor() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't')
  const a = createActor({ initial, idGen, clock: () => '<TS>' })
  return { a, aRoll: initial.tracks[0].id }
}

describe('dry_run halt/error (TS-only; the differential gate uses succeeding ops)', () => {
  it('halts at the first failing op and reports halted_at + status:error', () => {
    const { a, aRoll } = actor()
    const r = a.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'add_color_layer', track_id: aRoll, t_start_us: 0, t_end_us: 1000000, color: { r: 0, g: 0, b: 0, a: 255 } },
      { kind: 'delete_layer', layer_id: '00000000-0000-0000-0000-0000000000ff' }, // LayerNotFound → halt
      { kind: 'add_color_layer', track_id: aRoll, t_start_us: 2000000, t_end_us: 3000000, color: { r: 0, g: 0, b: 0, a: 255 } },
    ] }))
    expect(r.ok).toBe(true)
    const body = JSON.parse((r as { result: { content: Array<{ text: string }> } }).result.content[0].text)
    expect(body.halted_at).toBe(1)
    expect(body.results.length).toBe(2)            // stops after the failing op (3rd never runs)
    expect(body.results[0].status).toBe('ok')
    expect(body.results[1].status).toBe('error')
  })
  it('bad operation spec → invalid_params (no dry run executed)', () => {
    const { a } = actor()
    const r = a.mcpCall('dry_run', JSON.stringify({ operations: [{ kind: 'delete_layer', layer_id: 'not-a-uuid' }] }))
    expect(r.ok).toBe(false)
    expect((r as { error: { code: string } }).error.code).toBe('invalid_params')
  })
})
```

(Confirm vs Rust `do_dry_run`: it pushes the failing result THEN breaks — so `results` includes the failing entry and stops; `halted_at` = its index. The 3rd op never runs. Adjust the expected `results.length` if the Rust oracle for a halting case differs — but this is unit-only, modeled on `do_dry_run` lines 2301-2364.)

- [ ] **Step 7: Regen + gate + unit test.**

Run: `cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts src/main/state/__tests__/mcp.dryrun.test.ts`
Expected: the 3 dry-run sequences pass (full `env.result` byte-identical incl. the det layer ids in `add_layer`/`split_layer` outputs); the unit test passes. **If `dry-run-add`/`dry-run-split` state or trailing-id diverges**, the dry-run id-mint count differs between engines — verify TS `dryRun` AddLayer/SplitLayer call `applyAddLayer`/`applySplitLayer` with `idGen` (NOT a fresh gen), matching Rust `apply_add_layer`/`apply_split_layer` `new_id()` count.

- [ ] **Step 8: Full suite + typecheck + commit.**

```bash
cd apps/desktop && npx vitest run src/main/state && npx tsc -b
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/__tests__/mcp.dryrun.test.ts apps/desktop/fixtures/state-corpus/sequences-mcp/ apps/desktop/fixtures/state-corpus/oracle-mcp/
git commit -m "feat(state-migration): MCP dry_run (spec parse + DryRunOp/Output extension), gated (Phase 3d-b)"
```

---

### Task 5: Audit, README, dormancy + additivity verification

**Files:**
- Modify: `apps/desktop/fixtures/state-corpus/README.md`
- (No source change unless the audit finds a gap.)

**Interfaces:** none (verification task).

- [ ] **Step 1: Tool-coverage audit.** Confirm each of the 9 3d-b tools appears in ≥1 `sequences-mcp/*.json`: `set_keyframe`/`get_param_track` (set-keyframe.json + every keyframe seq); `remove_keyframe` (remove-keyframe.json, err-keyframe-not-found.json); `retime_keyframe` (retime-keyframe.json); `set_keyframe_easing` (set-keyframe-easing.json); `smooth_keyframes` (smooth-keyframes.json, smooth-keyframes-one.json); `clear_keyframes` (clear-keyframes.json, clear-keyframes-noop.json); `set_param_track` (set-param-track.json); `dry_run` (dry-run-add/split/void.json). If any tool is missing a sequence, add one (regen + gate) before proceeding.

- [ ] **Step 2: Dormancy verification.**

Run: `git -C ../.. diff --name-only main..phase-3d-b-keyframes -- apps/desktop/src/main/index.ts apps/desktop/src/main/mcp/server.ts apps/desktop/src/main/mcp/mutationTools.ts`
Expected: **empty** (no live-wiring files touched).

- [ ] **Step 3: Corpus additivity verification.**

Run: `git -C ../.. diff --diff-filter=M --name-only main..phase-3d-b-keyframes -- apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod apps/desktop/fixtures/state-corpus/oracle-mcp`
Expected: **empty** (only NEW `oracle-mcp/` files added; pre-existing oracles — including 3d-a's `oracle-mcp/` baseline — unmodified).

- [ ] **Step 4: Full gates.**

Run:
```bash
cd apps/desktop && npx vitest run && npx tsc -b
cargo test --manifest-path native/Cargo.toml --lib --features replay,jobs,export,mcp,cloud,motifs
```
Expected: full vitest suite green (all differential gates `skipped===[]`); `tsc -b` clean; Rust lib tests pass (unchanged — no Rust handler edits; only `mcp_driver` bin changed, which `cargo test --lib` does not run, but `cargo build` of the bin during regen already proved it compiles).

- [ ] **Step 5: Update the corpus README.** Extend the `### sequences-mcp / oracle-mcp` section in `apps/desktop/fixtures/state-corpus/README.md` to document the 3d-b additions: the 8 keyframe tools + `dry_run`; that keyframe tools reuse `renderer/keyframe/edits.ts` via `keyframeEdits.ts` with the actor's `idGen` injected for deterministic keyframe ids; the `kf_index` capture convention (`get_param_track` → name a server-minted keyframe id under `ref`); the `set_param_track` raw-`Animated` input vs `get_param_track` custom output shapes; that `dry_run` is gated with succeeding ops only (halt/error path unit-tested in `mcp.dryrun.test.ts`, NOT differential, to avoid twinning CommandError Display strings); and the keyframe param vocabulary note (Color has no animatable params → corpus uses no-audio VideoClip layers). Keep it evergreen/dateless per the docs convention; reference the 3d-b tools by name.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/fixtures/state-corpus/README.md
git commit -m "docs(state-migration): corpus README — 3d-b keyframes + dry_run mcp coverage (Phase 3d-b)"
```

---

## Self-Review (filled by the plan author)

**Spec coverage** (vs `2026-06-24-state-actor-phase-3d-design.md` §3d-b "keyframes + dry_run"):
- ✓ Wire `renderer/keyframe/edits.ts` reachable from main (Task 1 `keyframeEdits.ts`, mirrors `summary.ts`/`snap.ts` boundary debt).
- ✓ timeline-absolute↔layer-local time conversion (Task 1 `readLayerTrack` returns `t_start_us`; arms do `t_us - tStartUs` / `+ tStartUs` for get).
- ✓ all 8 keyframe tools compute a new `AnimTrack` then call `update_layer_param_track` (Tasks 2-3 via the gated `dispatch('update_layer_param_track')`).
- ✓ `get_param_track` read tool (Task 2, custom JSON shape).
- ✓ `dry_run` spec→`DryRunOp` parsing onto the existing `actor.dryRun` (Task 4 `specToDryRunOp`, + the missing-op-kind extension).
- ✓ Differential-gated (Tasks 2-4 via the reused `mcp.differential.test.ts`; det-id MCP channel; `mcp_driver` drives real `dispatch_tool`).
- ✓ DORMANT — no `server.ts`/`mutationTools.ts`/`index.ts` change (Global Constraints + Task 5 Step 2).
- ✓ Additive corpus (Task 5 Step 3).
- ✓ Error gating code+data, prose ungated (Global Constraints; KeyframeNotFound/UnknownKeyframeParam/LayerNotFound → invalid_params no data).

**Placeholder scan:** the only "verify at gate" points are (a) the `CommandFailure` assertion field in Task 1 Step 5 (concrete fallback given), (b) the `tsc -b` crypto-typing de-risk in Task 1 Step 6 (concrete fallback given), (c) `do_dry_run` halt `results.length` in Task 4 Step 6 (modeled on the cited Rust lines; oracle is the truth for the differential seqs, unit test is TS-modeled), (d) the smooth_keyframes f64 exactness in Task 3 Step 3 (with a STOP-and-report instruction if it reveals pre-existing renderer↔Rust drift). No bare TODOs; every code step shows the code.

**Type consistency:** `readLayerTrack`/`resolveAnimatedF64` signatures identical across Task 1 (def) and Tasks 2-4 (use). `shapeGetParamTrack`/`shapeDryRunResponse`/`dryRunErrorString`/`keyframePresent` defined once in `mcp-commands.ts`, consumed in `actor.ts`. `DryRunOp`/`DryRunOutput` extension (Task 4) consistent with the `dryRun` switch and `shapeDryRunResponse`'s expected input. `upsertKeyframe`/`liftToKeyframed` new optional params (`interp?`, `mkId?`) are backward-compatible with the 6 renderer call sites and the golden test. `kf_index` skip + capture symmetric across `mcp_driver.rs` (`build_args`/`extract_ref_id`) and `replay.ts` (`resolveWire`/`mcpRefId`).
