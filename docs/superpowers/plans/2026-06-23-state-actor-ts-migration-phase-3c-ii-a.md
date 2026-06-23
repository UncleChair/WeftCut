# State-actor TS migration — Phase 3c-ii-a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript production command adapter — the layer that translates the renderer's real category-A command channels (`add_color_layer`, `add_media_layer`, camelCase wire args, rich `LayerParams`) into the already-gated TS actor mutation engine — and prove it byte-identical to the real Rust production dispatch via a new deterministic-id differential gate. **No live wiring** (the `backend:invoke` flip is 3c-ii-d).

**Architecture:** A new det-id oracle (`prod_driver.rs`) drives Rust's *real* `Backend::dispatch` (production channel parsing) under deterministic ids, writing per-step canonical-state oracles to a new corpus dimension. A new TS production entrypoint `actor.command(channel, wireArgs)` reuses the gated `commit`/closures core; pure arg-parsing lives in `commands.ts`. A new `commands.differential.test.ts` asserts the TS adapter matches the Rust oracle op-by-op, exactly as the Phase-2/3a gates do for the mutation engine.

**Tech Stack:** TypeScript (Electron main, Immer-based actor), Rust (napi addon `@weftcut/core`), Vitest, deterministic-id differential corpus under `apps/desktop/fixtures/state-corpus/`.

## Global Constraints

- **Working dir for all commands:** `apps/desktop/`. Paths below are relative to it unless absolute.
- **The gate is the backstop:** the prod-differential is byte-exact, so a wrong field mapping → wrong state → red gate. Iterate the adapter against the gate; do not hand-wave field names.
- **Reuse the gated core:** the production entrypoint MUST call the existing `commit`/`runValidate`/closures/`apply*` helpers in `actor.ts` — never re-implement a mutation. Only arg-parsing + production param construction is new.
- **`dispatch()` stays untouched:** it is the replay-vocab corpus vehicle guarding 174 existing state oracles + 174 summary oracles. The production path is a *parallel* entrypoint.
- **Additive oracle regen only:** every regen must leave all pre-existing oracle files byte-identical. Verify with `git diff --diff-filter=M` over `fixtures/state-corpus/` = ∅.
- **Deterministic ids:** Rust det mode is `state::ids::det::{reset,enable,disable}` (process-global on `new_id()`, `ids.rs:20`). TS uses `seededGen()`. First minted id is `…0001`; blank project mints A-roll `…0001`, B-roll `…0002`, project `…0003`.
- **Oracle build env (verified working):** `cargo run --manifest-path native/Cargo.toml --bin <driver> --features replay,jobs,export,mcp,cloud,motifs -- <seq.json>`. The replay_driver build needs `FFMPEG_DIR=<Gyan.FFmpeg.Shared>/ffmpeg-8.1.1-full_build-shared`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH += $FFMPEG_DIR/bin`. `prod_driver` shares these.
- **Scope = the renderer category-A surface only.** The exact in-scope channel set is the non-debug state-mutation arms of `napi_backend.rs` `dispatch` (lines 388–712). Explicitly OUT of scope (deferred to 3d, because they are NOT in the production dispatch — MCP-only — or need infra the TS actor lacks): `add_marker`/`update_marker`/`remove_marker`, `delete_track`/`move_track`, `groups_add_members`/`groups_remove_members`/`groups_rename`, `add_transition`/`remove_transition`, `add_caption_track`, `project_restore_checkpoint` (no TS checkpoint infra yet). `add_demo_color_layer`/`add_demo_text_layer` are dev-only demo commands — include them (they are in the dispatch and trivial) so the splitter never hits an un-adapted channel.

---

## In-scope channel inventory (the adapter must cover all of these)

Derived from `napi_backend.rs` dispatch (lines 388–712). Wire field names are the camelCase form (Rust arg structs are `#[serde(rename_all="camelCase")]`; confirm each against `native/src/commands/mod.rs` + `src/renderer/ipc/index.ts` — the gate verifies correctness). "Mutation" = the existing TS actor capability to reuse.

| Production channel | Wire args | TS actor reuse | Notes |
|---|---|---|---|
| `add_track` | *(none; label defaults to `"Track"`)* | `applyAddTrack(d, idGen, "Track")` | Rust passes `Some("Track")`, not null |
| `add_color_layer` | `trackId?`, `color?`, `width?`, `height?`, `tStartUs`, `durationUs?` | `commit` + `applyAddLayer` w/ **prod** color params | default-fills (Task 3) |
| `add_text_layer` | `trackId?`, `content?`, `tStartUs`, `durationUs?` | `commit` + `applyAddLayer` w/ **prod** text params | Arial 72 DrawText (Task 3) |
| `add_media_layer` | `trackId`, `mediaId`, `tStartUs` | `commit` + `applyAddLayer` + auto-pair | richest (Task 3) |
| `add_demo_color_layer` | *(none)* | `commit` + `applyAddLayer` | demo color by layer index (Task 3) |
| `add_demo_text_layer` | *(none)* | `commit` + `applyAddLayer` | demo text (Task 3) |
| `update_layer` | `layerId`, `patch` | `applyUpdateLayer(d, layer, patch)` | patch passes through |
| `update_layer_params` | `layerId`, `patch` | `applyUpdateLayerParams` | patch passes through |
| `update_layer_param_track` | `layerId`, `paramKey`, `track` | `applyUpdateLayerParamTrack` | |
| `update_layer_param_tracks` | `layerId`, `entries` | loop `applyUpdateLayerParamTrack` | one commit |
| `move_layer` | `layerId`, `newTrackId`, `newTStartUs`, `escapeGroup?` | `applyMoveLayer` | |
| `trim_layer` | `layerId`, `edge`, `newTUs`, `escapeGroup?` | `applyTrimLayer` | edge `"in"→In`/`"out"→Out` |
| `delete_layer` | `layerId` | `applyDeleteLayer` | |
| `duplicate_layer` | `layerId`, `tOffsetUs` | `applyDuplicateLayer` | returns id |
| `split_layer_grouped` | `layerId`, `atTUs`, `escapeGroup?` | `applySplitLayer` | Rust returns `(left,right)` tuple |
| `groups_create` | `layerIds`, `label?`, `reassign?` | `applyGroupsCreate` | returns group id |
| `groups_dissolve` | `groupId` | `applyGroupsDissolve` | |
| `add_effect` | `layerId`, `kind` | `applyAddEffect` | returns effect id |
| `update_effect` | `layerId`, `effectId`, `patch` | `applyUpdateEffect` | |
| `move_effect` | `layerId`, `effectId`, `newIndex` | `applyMoveEffect` | |
| `remove_effect` | `layerId`, `effectId` | `applyRemoveEffect` | |
| `set_composition` | `patch` | `setComposition(patch)` closure | |
| `fit_composition_to_layers` | *(none)* | `applyFitComposition` | |
| `update_track_flags` | `trackId`, `patch` | `updateTrackFlags` closure | unrecorded |
| `set_role_gain` | `role`, `gainDb` | `setRoleGain` closure | |
| `update_role_flags` | `role`, `patch` | `updateRoleFlags` closure | unrecorded |
| `separate_audio_to_new_track` | `layerId` | `applySeparateAudio` | returns track id |
| `restyle_caption_track` | `trackId`, `patch` | `applyRestyleCaptionTrack` | |
| `update_project_settings` | `patch` | `updateProjectSettings` closure | unrecorded |
| `project_undo` | *(none)* | `undo()` | |
| `project_redo` | *(none)* | `redo()` | |

---

## File structure

- **Create** `native/src/bin/prod_driver.rs` — det-id oracle driver over the real `Backend::dispatch`.
- **Modify** `native/src/napi_backend.rs` — add a `replay`-gated Backend constructor, slim init, and handle accessor (so a bin can stand up a Backend + read snapshots without `init()`'s background tasks).
- **Modify** `native/Cargo.toml` — declare the `prod_driver` bin (`required-features = ["replay"]`).
- **Modify** `scripts/gen-state-oracle.mjs` — also run `prod_driver` over a new production sequence dir, writing `oracle-prod/`.
- **Create** `src/main/state/commands.ts` — pure production arg-parsing + production param builders.
- **Modify** `src/main/state/actor.ts` — add `command(channel, wireArgs)` to the `ActorHandle` (parallel to `dispatch`), reusing the gated core.
- **Modify** `src/main/state/replay.ts` — add `replayProductionSequence` (drives `actor.command`, media-seed handling, @ref capture).
- **Create** `src/main/state/__tests__/commands.differential.test.ts` — the new gate.
- **Create** `src/main/state/__tests__/commands.test.ts` — unit tests for the pure parsers/builders.
- **Create** `fixtures/state-corpus/sequences-prod/*.json` — production-channel corpus.
- **Create (generated)** `fixtures/state-corpus/oracle-prod/*.json` — det oracles.
- **Modify** `fixtures/state-corpus/README.md` — document the new dimension + the in/out-of-scope channel split.

---

### Task 1: Oracle harness — `prod_driver` det-id spike (de-risk)

This is the riskiest piece; do it first and prove the whole approach on a 2-command sequence before building the adapter.

**Files:**
- Modify: `native/src/napi_backend.rs`
- Create: `native/src/bin/prod_driver.rs`
- Modify: `native/Cargo.toml` (after the `replay_driver` `[[bin]]`, ~line 109)
- Modify: `scripts/gen-state-oracle.mjs`
- Create: `fixtures/state-corpus/sequences-prod/_smoke-prod.json`

**Interfaces:**
- Produces (Rust, `replay`-gated, on `Backend`): `pub fn new_for_replay(events: Arc<dyn EventSink>, config_dir: String, cache_dir: String) -> Self`; `pub async fn init_for_replay(&self) -> ProjectHandle` (spawns the actor, sets `self.project`, returns the handle clone; NO event-bridge/autosave/motif/ffmpeg tasks).
- Produces (oracle files): `fixtures/state-corpus/oracle-prod/<name>.json` with shape `{ name, steps: [{ op, ok, error, state }] }` — identical to `oracle/` shape.
- Consumes: `Backend::dispatch(&self, cmd, args)` (`napi_backend.rs:386`), `state::ids::det`, `state::spawn`, `ProjectHandle::snapshot`.

- [ ] **Step 1: Add the replay-gated Backend constructor + slim init + handle accessor**

In `native/src/napi_backend.rs`, after the `#[cfg(test)] pub fn new_for_test(...)` helper (~line 375), add (NOT cfg(test) — gated on the `replay` feature so the bin can use it):

```rust
/// Replay-harness constructor: a Backend with a no-op event sink and on-disk
/// temp dirs, for the differential `prod_driver` bin. Mirrors `new_for_test`
/// but is available under the `replay` feature (bins are not `cfg(test)`).
#[cfg(feature = "replay")]
pub fn new_for_replay(events: std::sync::Arc<dyn EventSink>, config_dir: String, cache_dir: String) -> Self {
    build_backend(events, config_dir, cache_dir)
}

/// Slim init for the replay harness: spawn the actor and store the handle,
/// WITHOUT the event-bridge / autosave / motif-watcher / ffmpeg tasks that
/// `init()` starts (none are part of command→state evolution). Returns the
/// handle so the bin can snapshot between commands.
#[cfg(feature = "replay")]
pub async fn init_for_replay(&self) -> ProjectHandle {
    let handle = state::spawn(state::Project::new_blank("replay"));
    self.project.set(handle.clone()).ok();
    handle
}
```

- [ ] **Step 2: Add a no-op EventSink the bin can construct**

Search for the `EventSink` trait + an existing test sink (`VecEventSink`). If `VecEventSink::new()` is reachable under the `replay` feature, use it. Otherwise add, near the trait:

```rust
/// Discards all events. For the replay harness, which evolves state only.
#[cfg(feature = "replay")]
pub struct NullEventSink;
#[cfg(feature = "replay")]
impl EventSink for NullEventSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}
```

(Match the real `EventSink` trait signature exactly — read it first; the `emit` shape above is from `init()`'s `events.emit("project:changed", json)` usage.)

- [ ] **Step 3: Create `native/src/bin/prod_driver.rs`**

Drives the REAL production dispatch. Reads a production sequence (`{name, commands:[{op, ...wireArgs, ref?}]}`), enables det mode, runs each command through `Backend::dispatch`, captures canonical state per step. `add_media` is a pool-seed op (not a dispatch command) applied via the handle directly, mirroring how the renderer never adds to the pool but import does.

```rust
//! Production-command differential oracle. Drives the REAL Backend::dispatch
//! (production channel parsing) with deterministic ids. Build/run with
//! `--features replay,jobs,export,mcp,cloud,motifs`. NOT in the production addon.
use std::collections::HashMap;
use serde_json::{json, Value};
use weftcut_lib::napi_backend::{Backend, NullEventSink};
use weftcut_lib::state::{self, Actor};
use weftcut_lib::state::ids::det;

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: prod_driver <sequence.json>");
    let seq: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let name = seq["name"].as_str().unwrap_or("unnamed").to_string();

    det::reset();
    det::enable();
    let tmp = std::env::temp_dir().join(format!("weftcut-prod-{}", std::process::id()));
    let backend = Backend::new_for_replay(
        std::sync::Arc::new(NullEventSink),
        tmp.join("config").to_string_lossy().to_string(),
        tmp.join("cache").to_string_lossy().to_string(),
    );
    let h = backend.init_for_replay().await; // mints A(#1) B(#2) project(#3)
    let a_roll = h.snapshot().await.tracks[0].id.to_string();
    let b_roll = h.snapshot().await.tracks[1].id.to_string();

    let mut refs: HashMap<String, String> = HashMap::new();
    refs.insert("A".into(), a_roll);
    refs.insert("B".into(), b_roll);

    let mut steps = Vec::new();
    for cmd in seq["commands"].as_array().unwrap() {
        let op = cmd["op"].as_str().unwrap().to_string();
        let (ok, error, ret) = if op == "add_media" {
            // Pool seed (renderer never does this; import does). Apply via handle.
            match h.add_media_item(Actor::User, media_item(cmd)).await {
                Ok(id) => (true, None, Some(id.to_string())),
                Err(e) => (false, Some(format!("{e:?}")), None),
            }
        } else {
            let args = build_wire_args(cmd, &refs);
            match backend.dispatch(&op, &serde_json::to_string(&args).unwrap()).await {
                Ok(ret_json) => (true, None, extract_ref_id(&op, &ret_json)),
                Err(e) => (false, Some(e), None),
            }
        };
        if let (true, Some(id)) = (ok, &ret) {
            if let Some(rf) = cmd["ref"].as_str() { refs.insert(rf.to_string(), id.clone()); }
        }
        let snap = h.snapshot().await;
        steps.push(json!({ "op": op, "ok": ok, "error": error, "state": canonical_state(&snap) }));
    }
    det::disable();
    println!("{}", serde_json::to_string_pretty(&json!({ "name": name, "steps": steps })).unwrap());
}
```

Add helpers in the same file:
- `build_wire_args(cmd, refs)` — copy every key of `cmd` except `op`/`ref` into a new object, resolving any value that is a `@`-ref string via `refs` (reuse `resolve_id`-style logic but keep strings as JSON, since dispatch deserializes them). For id-bearing fields, substitute the resolved uuid string.
- `extract_ref_id(op, ret_json)` — for `add_*_layer`/`add_track`/`add_effect`/`groups_create`/`duplicate_layer`/`separate_audio_to_new_track`, the dispatch result is a JSON string of the id (`"\"<uuid>\""`); parse it. For `split_layer_grouped` the result is a tuple — capture `left` (the original) under `ref`. Others → `None`.
- `canonical_state(p)` — copy verbatim from `replay_driver.rs:63-70` (`<TS>`-normalize `metadata.created_at`/`modified_at`).
- `media_item(cmd)` — copy verbatim from `replay_driver.rs:394-410`.

(Note: `Backend` and `NullEventSink` must be reachable as `weftcut_lib::napi_backend::...`. Confirm the module path; if `napi_backend` is private, add `pub use` in `lib.rs` under `#[cfg(feature="replay")]`, exactly as `build_project_summary` was re-exported for Phase 3a.)

- [ ] **Step 4: Declare the bin in `native/Cargo.toml`**

After the existing `replay_driver` `[[bin]]` block:

```toml
[[bin]]
name = "prod_driver"
path = "src/bin/prod_driver.rs"
required-features = ["replay"]
```

- [ ] **Step 5: Author the smoke production sequence**

Create `fixtures/state-corpus/sequences-prod/_smoke-prod.json`:

```json
{
  "name": "_smoke-prod",
  "commands": [
    { "op": "add_track" },
    { "op": "add_color_layer", "trackId": "@A", "tStartUs": 0, "durationUs": 1000000 }
  ]
}
```

- [ ] **Step 6: Extend `scripts/gen-state-oracle.mjs` to generate prod oracles**

Add, after the existing state/summary generation:

```javascript
// Production-channel oracles: real Backend.dispatch under det ids.
const SEQ_PROD = 'fixtures/state-corpus/sequences-prod'
const OUT_PROD = 'fixtures/state-corpus/oracle-prod'
mkdirSync(OUT_PROD, { recursive: true })
const runProd = (file) => execFileSync('cargo', [
  'run', '--quiet', '--manifest-path', 'native/Cargo.toml',
  '--bin', 'prod_driver', '--features', 'replay,jobs,export,mcp,cloud,motifs', '--', join(SEQ_PROD, file),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
for (const file of readdirSync(SEQ_PROD).filter((f) => f.endsWith('.json'))) {
  const a = runProd(file), b = runProd(file)
  if (a !== b) { console.error(`NONDETERMINISTIC (prod): ${file}`); fail++; continue }
  writeFileSync(join(OUT_PROD, file), a)
  console.log(`ok  prod/${file}`)
}
```

- [ ] **Step 7: Generate the smoke oracle and verify det ids + additivity**

Run: `node scripts/gen-state-oracle.mjs`
Expected: `ok  prod/_smoke-prod.json` printed; no `NONDETERMINISTIC`. Open `fixtures/state-corpus/oracle-prod/_smoke-prod.json` and confirm: step 0 (`add_track`) is `ok:true` with a new track id `…0004`; step 1 (`add_color_layer`) layer id `…0005`; `metadata.*` are `"<TS>"`. Confirm `git status` shows the existing `oracle/` + `oracle-summary/` files **unchanged** (additive).

- [ ] **Step 8: Commit**

```bash
git add native/src/napi_backend.rs native/src/bin/prod_driver.rs native/Cargo.toml scripts/gen-state-oracle.mjs fixtures/state-corpus/sequences-prod fixtures/state-corpus/oracle-prod
git commit -m "test(state-migration): prod_driver det-id oracle harness (Phase 3c-ii-a)"
```

---

### Task 2: TS production entrypoint + gate, first mechanical channels

**Files:**
- Create: `src/main/state/commands.ts`
- Modify: `src/main/state/actor.ts` (add `command` to `ActorHandle` + `createActor` return)
- Modify: `src/main/state/replay.ts` (add `replayProductionSequence`)
- Create: `src/main/state/__tests__/commands.differential.test.ts`
- Create: `fixtures/state-corpus/sequences-prod/add-track.json`, `update-layer-on-prod-color.json`

**Interfaces:**
- Produces: `actor.command(channel: string, wireArgs: Record<string, unknown>): DispatchResult` (same `DispatchResult` type as `dispatch`).
- Produces: `commands.ts` pure helpers (filled in over Tasks 2–4); for now `PRODUCTION_OPS: Set<string>` and `parseProductionArgs(channel, wireArgs): { op: string; args: Record<string, unknown> } | null` for the mechanical channels whose only transform is camelCase→actor-arg renaming.
- Produces: `replayProductionSequence(seq): Trace` (in `replay.ts`).
- Consumes: the actor's existing `commit`/closures (internal); `canonicalize`, `serializeProject`, `tsErrorVariant`, `seededGen`, `blankProject`.

- [ ] **Step 1: Write the failing gate (smoke + add-track)**

Create `src/main/state/__tests__/commands.differential.test.ts` (mirror `differential.phase2.test.ts` structure, but corpus = `sequences-prod`, oracle = `oracle-prod`, replay fn = `replayProductionSequence`):

```typescript
// apps/desktop/src/main/state/__tests__/commands.differential.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { parseOracleErrorVariant } from '../errors'
import { replayProductionSequence, productionSequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences-prod')
const ORACLE = join(ROOT, 'oracle-prod')

describe('Phase 3c-ii-a differential: TS production adapter === Rust dispatch oracle', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  const skipped = files.filter((f) => !productionSequenceIsSupported(JSON.parse(readFileSync(join(SEQ, f), 'utf8'))))

  it('every production corpus sequence is in-vocabulary (no silent skips)', () => {
    expect(skipped.sort(), `unexpectedly skipped: ${skipped.join(', ')}`).toEqual([])
  })

  for (const f of files) {
    it(`matches the prod oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing oracle-prod ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replayProductionSequence(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts = trace.steps[i], or = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.state), `state ${where}`).toBe(JSON.stringify(canonicalize(or.state)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (!ts.ok) expect(parseOracleErrorVariant(String(ts.error)), `error ${where}`).toEqual(parseOracleErrorVariant(String(or.error)))
      }
    })
  }
})
```

- [ ] **Step 2: Run the gate to verify it fails**

Run: `npx vitest run src/main/state/__tests__/commands.differential.test.ts`
Expected: FAIL — `replayProductionSequence` / `productionSequenceIsSupported` not exported from `replay.ts`.

- [ ] **Step 3: Create `commands.ts` with the mechanical-channel parser**

```typescript
// apps/desktop/src/main/state/commands.ts
// Production command adapter: translates the renderer's real category-A
// channels + camelCase wire args into the gated TS actor mutation core.
// The byte-exact prod-differential gate is the backstop for every mapping.

/** Channels whose ONLY transform is camelCase→actor-arg renaming (no rich
 *  param construction). The layer-creation family is handled in actor.command. */
const MECHANICAL: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> = {
  add_track: () => ({ op: 'add_track', args: { label: 'Track' } }),
  update_layer: (a) => ({ op: 'update_layer', args: { layer: a.layerId, patch: a.patch } }),
  // (more added in Task 4)
}

/** All production channels this adapter handles (mechanical + rich + meta). */
export const PRODUCTION_OPS = new Set<string>([
  'add_track', 'update_layer',
  // (extended in Tasks 3–4)
])

export function parseMechanical(channel: string, a: Record<string, unknown>): { op: string; args: Record<string, unknown> } | null {
  const fn = MECHANICAL[channel]
  return fn ? fn(a) : null
}
```

- [ ] **Step 4: Add `command()` to the actor**

In `actor.ts`, add to the `ActorHandle` interface: `command(channel: string, wireArgs: Record<string, unknown>): DispatchResult`. In `createActor`, add the method (parallel to `dispatch`), routing mechanical channels through the existing `dispatch` after parsing, and reserving rich channels for Task 3:

```typescript
  function command(channel: string, wireArgs: Record<string, unknown>): DispatchResult {
    const mech = parseMechanical(channel, wireArgs)
    if (mech) return dispatch(mech.op, mech.args)
    // Rich channels (add_*_layer, demo) handled in Task 3; meta in Task 4.
    return { ok: false, error: { error: 'InvalidArgument', field: 'op', detail: `unsupported production op ${channel}` } }
  }
```

Add `command` to the returned handle object and `import { parseMechanical, PRODUCTION_OPS } from './commands'`.

- [ ] **Step 5: Add `replayProductionSequence` to `replay.ts`**

```typescript
import { PRODUCTION_OPS } from './commands'

export function productionSequenceIsSupported(seq: Sequence): boolean {
  return seq.commands.every((c) => c.op === 'add_media' || PRODUCTION_OPS.has(c.op))
}

/** Drives the production adapter (actor.command) over a production-channel
 *  sequence. `add_media` is a pool seed via the existing dispatch path. */
export function replayProductionSequence(seq: Sequence): Trace {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  const aRoll = initial.tracks[0].id, bRoll = initial.tracks[1].id
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const refs = new Map<string, string>([['A', aRoll], ['B', bRoll]])
  const steps: TraceStep[] = []
  for (const cmd of seq.commands) {
    const wire = resolveWire(cmd, refs) // copy cmd minus op/ref, resolve @refs in string values
    const r = cmd.op === 'add_media'
      ? actor.dispatch('add_media', { id: cmd.id, kind: cmd.kind, duration_us: cmd.duration_us ?? null })
      : actor.command(cmd.op, wire)
    let error: string | null = null
    if (r.ok) { if (cmd.ref && typeof r.value === 'string') refs.set(cmd.ref, r.value) }
    else { const v = tsErrorVariant(r.error); error = v.inner ? `${v.top}(${v.inner})` : v.top }
    steps.push({ op: cmd.op, ok: r.ok, error, state: canonicalize(serializeProject(actor.snapshot())) })
  }
  return { name: seq.name, steps }
}
```

Add a `resolveWire(cmd, refs)` helper: returns a shallow copy of `cmd` without `op`/`ref`, with any string value of the form `@X` replaced by `refs.get(X)`.

- [ ] **Step 6: Author the two corpus sequences**

`fixtures/state-corpus/sequences-prod/add-track.json`:
```json
{ "name": "add-track", "commands": [ { "op": "add_track" } ] }
```
`fixtures/state-corpus/sequences-prod/update-layer-on-prod-color.json`:
```json
{ "name": "update-layer-on-prod-color", "commands": [
  { "op": "add_color_layer", "trackId": "@A", "tStartUs": 0, "durationUs": 1000000, "ref": "L1" },
  { "op": "update_layer", "layerId": "@L1", "patch": { "label": "renamed" } }
] }
```
(`add_color_layer` is wired in Task 3; this sequence will go green after Task 3. For Task 2, keep `update-layer-on-prod-color.json` out and add only `add-track.json` + the smoke; re-add it in Task 3.)

- [ ] **Step 7: Regenerate oracles and run the gate**

Run: `node scripts/gen-state-oracle.mjs` then `npx vitest run src/main/state/__tests__/commands.differential.test.ts`
Expected: PASS for `_smoke-prod` and `add-track`. `git diff --diff-filter=M fixtures/state-corpus/oracle fixtures/state-corpus/oracle-summary` = ∅.

- [ ] **Step 8: Typecheck + commit**

Run: `npx tsc -p tsconfig.main.json --noEmit` → clean.
```bash
git add src/main/state/commands.ts src/main/state/actor.ts src/main/state/replay.ts src/main/state/__tests__/commands.differential.test.ts fixtures/state-corpus/sequences-prod fixtures/state-corpus/oracle-prod
git commit -m "feat(state-migration): TS production command entrypoint + differential gate (Phase 3c-ii-a)"
```

---

### Task 3: Layer-creation family (rich params + production defaults + auto-pair)

The highest-drift channels. Production defaults differ from the replay vehicle's (e.g. `add_text_layer` uses Arial 72 + `DrawText`, NOT the `textParamsDefault` Inter 48 + `Auto`). Build NEW production param builders.

**Files:**
- Modify: `src/main/state/commands.ts` (add prod param builders + extend `PRODUCTION_OPS`)
- Modify: `src/main/state/actor.ts` (`command` rich-channel arms)
- Create: `fixtures/state-corpus/sequences-prod/`: `add-color-defaults.json`, `add-color-explicit.json`, `add-text-defaults.json`, `add-text-content.json`, `add-media-video.json`, `add-media-audio.json`, `add-media-image.json`, `add-media-video-autopair.json`, `add-demo-color.json`, `add-demo-text.json`
- Create/extend: `src/main/state/__tests__/commands.test.ts` (unit tests for the builders)

**Interfaces:**
- Consumes: `applyAddLayer`, `colorParams`, `videoClipParams`/`audioParams`/`imageOverlayParams` (`mutations/media.ts`), `defaultTransform`, the actor's `commit`, `idGen`, `current()` (composition + media_pool + settings).
- Produces (in `commands.ts`): `prodColorParams(a, comp)`, `prodTextParams(a)`, `prodMediaLayer(a, project)` → `{ params, durationUs, autoPair?: {...} }`.

- [ ] **Step 1: Verify the Rust production constructors verbatim**

Read `native/src/commands/mutations.rs` for `add_color_layer` (≈378), `add_text_layer_impl` (≈269–305), `add_media_layer` (≈73–183 incl. the auto-pair block ≈146–180), and the helpers `total_src`/`image_layer_span_us`/`demo_color`. Note exactly: color default = `Rgba::BLACK` ({0,0,0,255} — confirm), width/height default = `composition.width`/`height`; text default content `"Text"`, font `Arial`/`72.0`/`400`/`!italic`, white, `Center`, `TextBackend::DrawText`; media `src_in=0`, `src_out=total_src`, kind-matched params; the auto-pair predicate (`kind==Video && media has audio metadata && <setting>`), where the setting is read from (project settings vs app settings — record the exact source), and that auto-pair creates a paired Audio layer + `groups_create([video,audio])`. Write these facts as a comment block atop the new builders in `commands.ts`.

- [ ] **Step 2: Write failing unit tests for the builders**

In `src/main/state/__tests__/commands.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { prodColorParams, prodTextParams } from '../commands'

describe('production param builders', () => {
  it('color defaults to black + composition size', () => {
    const p = prodColorParams({}, { width: 1920, height: 1080 })
    expect(p).toMatchObject({ kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1920, height: 1080 })
  })
  it('text production defaults are Arial 72 DrawText', () => {
    const p = prodTextParams({}) as Extract<ReturnType<typeof prodTextParams>, { kind: 'Text' }>
    expect(p.content).toBe('Text')
    expect(p.font).toEqual({ family: 'Arial', size_px: 72, weight: 400, italic: false })
    expect(p.backend_hint).toBe('DrawText')
  })
})
```

Run: `npx vitest run src/main/state/__tests__/commands.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement the production param builders in `commands.ts`**

```typescript
import type { LayerParams, Project, Rgba } from './model'
import { defaultTransform } from './mutations/add'

/** add_color_layer (mutations.rs:378): color→BLACK, w/h→composition. */
export function prodColorParams(a: Record<string, unknown>, comp: { width: number; height: number }): LayerParams {
  const color = (a.color as Rgba | undefined) ?? { r: 0, g: 0, b: 0, a: 255 }
  return { kind: 'Color', color: { mode: 'Static', value: color },
    width: (a.width as number | undefined) ?? comp.width,
    height: (a.height as number | undefined) ?? comp.height }
}

/** add_text_layer (mutations.rs:282-299): content→"Text", Arial 72 DrawText. */
export function prodTextParams(a: Record<string, unknown>): LayerParams {
  return { kind: 'Text', content: (a.content as string | undefined) ?? 'Text',
    font: { family: 'Arial', size_px: 72, weight: 400, italic: false },
    color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
    align: 'Center', transform: defaultTransform(), opacity: { mode: 'Static', value: 1 },
    shadow: null, outline: null, intro: null, outro: null, backend_hint: 'DrawText' }
}
```

Plus `prodMediaLayer(a, project)` returning `{ params, durationUs, autoPair }` per Step 1's findings (kind-match via `project.media_pool[mediaId].kind`; `durationUs` from media metadata `total_src` / image span; `autoPair` populated when the Video-with-audio + setting predicate holds). Extend `PRODUCTION_OPS` with `add_color_layer`, `add_text_layer`, `add_media_layer`, `add_demo_color_layer`, `add_demo_text_layer`.

- [ ] **Step 4: Wire the rich arms in `actor.command`**

```typescript
    switch (channel) {
      case 'add_color_layer': {
        const t0 = wireArgs.tStartUs as number
        const dur = resolveDurationUs(wireArgs.durationUs as number | undefined)   // from Step 1
        const trackId = resolveDefaultTrack(wireArgs.trackId as Uuid | undefined, current()) // from Step 1
        const id = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
          applyAddLayer(d, idGen, trackId, prodColorParams(wireArgs, d.composition), t0, t0 + dur))
        return { ok: true, value: id }
      }
      // add_text_layer: same shape with prodTextParams.
      // add_media_layer: prodMediaLayer(wireArgs, current()) → { params, durationUs, autoPair }.
      //   When autoPair is set, perform BOTH layer inserts + the group create
      //   INSIDE a single commit so the id-allocation order matches Rust
      //   (video layer id, then audio layer id, then group id — verify vs mutations.rs).
      // add_demo_color_layer / add_demo_text_layer: no wire args; params from the
      //   demo builders (color by current layer count) — confirm vs mutations.rs.
    }
```

Define the two resolvers from Step 1's findings as small pure functions in `commands.ts`: `resolveDefaultTrack(trackId, project)` (Rust's fallback when `trackId` is absent — e.g. the first non-reserved/A-roll track; confirm) and `resolveDurationUs(durationUs)` (Rust's constant default when `durationUs` is absent; confirm). Encode the exact values/logic; the byte-exact gate confirms them. For `add_media_layer` auto-pair, the single-`commit` requirement above is the id-order keystone.

- [ ] **Step 5: Author the corpus sequences**

Write the 10 sequences. For media ones, prefix with an `add_media` pool seed, e.g. `add-media-video-autopair.json`:
```json
{ "name": "add-media-video-autopair", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 5000000 },
  { "op": "add_media_layer", "trackId": "@A", "mediaId": "00000000-0000-0000-0000-0000000000aa", "tStartUs": 0, "ref": "L1" },
  { "op": "add_track" }
] }
```
(The trailing `add_track` reveals the post-op id, pinning the id-burn count — video layer, paired audio layer, group, then this track.) Add a non-auto-pair video media (audio-less metadata) and an explicit-color/explicit-content variant. Re-add `update-layer-on-prod-color.json` from Task 2.

- [ ] **Step 6: Regenerate, run both test files**

Run: `node scripts/gen-state-oracle.mjs`
Run: `npx vitest run src/main/state/__tests__/commands.test.ts src/main/state/__tests__/commands.differential.test.ts`
Expected: PASS. If `add-media-video-autopair` diverges, fix the auto-pair predicate/id-order in `prodMediaLayer`/`command` against the oracle (do NOT edit the oracle). Confirm `git diff --diff-filter=M` over `oracle/` + `oracle-summary/` = ∅.

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc -p tsconfig.main.json --noEmit` → clean.
```bash
git add src/main/state/commands.ts src/main/state/actor.ts src/main/state/__tests__/commands.test.ts fixtures/state-corpus/sequences-prod fixtures/state-corpus/oracle-prod
git commit -m "feat(state-migration): production layer-creation adapter + auto-pair (Phase 3c-ii-a)"
```

---

### Task 4: Remaining mechanical + meta channels

All remaining in-scope channels. These are uniform camelCase→actor-arg maps; `set_composition`/`update_track_flags`/`set_role_gain`/`update_role_flags`/`update_project_settings` route to the actor's dedicated closures via `dispatch`; `undo`/`redo` map to `project_undo`/`project_redo`.

**Files:**
- Modify: `src/main/state/commands.ts` (fill `MECHANICAL` + extend `PRODUCTION_OPS`)
- Create: one corpus sequence per channel under `sequences-prod/` exercising both a success and a representative reject where cheap.

**Interfaces:**
- Consumes: the actor's existing `dispatch` ops (`move_layer`, `trim_layer`, `delete_layer`, `duplicate_layer`, `split_layer`, `groups_create`, `groups_dissolve`, `update_layer_params`, `update_layer_param_track`, `update_layer_param_tracks`, `add_effect`, `update_effect`, `move_effect`, `remove_effect`, `set_composition`, `fit_composition_to_layers`, `update_track_flags`, `set_role_gain`, `update_role_flags`, `separate_audio`, `restyle_caption_track`, `update_project_settings`, `undo`, `redo`).

- [ ] **Step 1: Fill the `MECHANICAL` table**

Add every mapping. Each entry renames camelCase wire fields to the actor `dispatch` arg names (see `actor.ts:322` for the exact expected names) and selects the actor op. Representative entries (apply the same shape to all):

```typescript
  move_layer: (a) => ({ op: 'move_layer', args: { layer: a.layerId, to_track: a.newTrackId, t_start_us: a.newTStartUs, escape_group: a.escapeGroup ?? false } }),
  trim_layer: (a) => ({ op: 'trim_layer', args: { layer: a.layerId, edge: a.edge, new_t_us: a.newTUs, escape_group: a.escapeGroup ?? false } }),
  delete_layer: (a) => ({ op: 'delete_layer', args: { layer: a.layerId } }),
  duplicate_layer: (a) => ({ op: 'duplicate_layer', args: { layer: a.layerId, t_offset_us: a.tOffsetUs } }),
  split_layer_grouped: (a) => ({ op: 'split_layer', args: { layer: a.layerId, at_t_us: a.atTUs, escape_group: a.escapeGroup ?? false } }),
  groups_create: (a) => ({ op: 'groups_create', args: { layers: a.layerIds, label: a.label ?? null, reassign: a.reassign ?? false } }),
  groups_dissolve: (a) => ({ op: 'groups_dissolve', args: { group: a.groupId } }),
  update_layer_params: (a) => ({ op: 'update_layer_params', args: { layer: a.layerId, patch: a.patch } }),
  update_layer_param_track: (a) => ({ op: 'update_layer_param_track', args: { layer: a.layerId, param_key: a.paramKey, track: a.track } }),
  update_layer_param_tracks: (a) => ({ op: 'update_layer_param_tracks', args: { layer: a.layerId, entries: a.entries } }),
  add_effect: (a) => ({ op: 'add_effect', args: { layer: a.layerId, kind: a.kind } }),
  update_effect: (a) => ({ op: 'update_effect', args: { layer: a.layerId, effect: a.effectId, patch: a.patch } }),
  move_effect: (a) => ({ op: 'move_effect', args: { layer: a.layerId, effect: a.effectId, new_index: a.newIndex } }),
  remove_effect: (a) => ({ op: 'remove_effect', args: { layer: a.layerId, effect: a.effectId } }),
  set_composition: (a) => ({ op: 'set_composition', args: a.patch as Record<string, unknown> }),
  fit_composition_to_layers: () => ({ op: 'fit_composition_to_layers', args: {} }),
  update_track_flags: (a) => ({ op: 'update_track_flags', args: { track: a.trackId, patch: a.patch } }),
  set_role_gain: (a) => ({ op: 'set_role_gain', args: { role: a.role, gain_db: a.gainDb } }),
  update_role_flags: (a) => ({ op: 'update_role_flags', args: { role: a.role, patch: a.patch } }),
  separate_audio_to_new_track: (a) => ({ op: 'separate_audio', args: { layer: a.layerId } }),
  restyle_caption_track: (a) => ({ op: 'restyle_caption_track', args: { track: a.trackId, patch: a.patch } }),
  update_project_settings: (a) => ({ op: 'update_project_settings', args: { patch: a.patch } }),
  project_undo: () => ({ op: 'undo', args: {} }),
  project_redo: () => ({ op: 'redo', args: {} }),
```

Note `split_layer_grouped` → actor `split_layer`: the actor returns the right-half id, but the Rust dispatch returns a `(left, right)` tuple and `prod_driver.extract_ref_id` captures `left` (the original layer id, which is stable). Ensure the corpus seq's `ref` (if any) is only used to address the original layer in later steps — do not rely on the right-half id matching across engines unless verified. Extend `PRODUCTION_OPS` with all of the above.

- [ ] **Step 2: Author one corpus sequence per channel**

For each channel, a minimal sequence that sets up prerequisites with already-passing production channels then exercises the target, ending in a trailing `add_track` to pin id-burn. Example `move-layer.json`:
```json
{ "name": "move-layer", "commands": [
  { "op": "add_color_layer", "trackId": "@A", "tStartUs": 0, "durationUs": 1000000, "ref": "L1" },
  { "op": "move_layer", "layerId": "@L1", "newTrackId": "@B", "newTStartUs": 2000000 },
  { "op": "add_track" }
] }
```
Write one per channel (24 files). Patch-bearing channels (`update_layer_params`, `update_effect`, `set_composition`, `update_track_flags`, `update_role_flags`, `restyle_caption_track`, `update_project_settings`, keyframe tracks) send the patch in the SAME shape the renderer sends (snake_case inner fields, e.g. `{ "patch": { "kind": "Color", "color": { "r": 0, "g": 255, "b": 0, "a": 255 } } }`) — cross-check the patch shape against `src/renderer/ipc/index.ts` and the Rust patch struct.

- [ ] **Step 3: Regenerate + run the gate**

Run: `node scripts/gen-state-oracle.mjs` then `npx vitest run src/main/state/__tests__/commands.differential.test.ts`
Expected: PASS for all sequences; `skipped===[]`. Fix the adapter (never the oracle) on any divergence. `git diff --diff-filter=M` over `oracle/` + `oracle-summary/` = ∅.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc -p tsconfig.main.json --noEmit` → clean.
```bash
git add src/main/state/commands.ts fixtures/state-corpus/sequences-prod fixtures/state-corpus/oracle-prod
git commit -m "feat(state-migration): production adapter for remaining category-A channels (Phase 3c-ii-a)"
```

---

### Task 5: Completeness audit, full-suite gate, docs

**Files:**
- Modify: `src/main/state/__tests__/commands.test.ts` (add a dispatch-coverage assertion)
- Modify: `fixtures/state-corpus/README.md`

**Interfaces:** consumes `PRODUCTION_OPS`.

- [ ] **Step 1: Add a coverage assertion**

In `commands.test.ts`, assert that `PRODUCTION_OPS` exactly equals the intended in-scope set (a hard-coded literal list copied from this plan's inventory table), so a future un-adapted renderer channel or an accidental extra is caught:

```typescript
it('PRODUCTION_OPS matches the 3c-ii-a in-scope renderer surface', () => {
  expect([...PRODUCTION_OPS].sort()).toEqual([
    'add_color_layer','add_demo_color_layer','add_demo_text_layer','add_effect','add_media_layer','add_text_layer','add_track',
    'delete_layer','duplicate_layer','fit_composition_to_layers','groups_create','groups_dissolve','move_effect','move_layer',
    'project_redo','project_undo','remove_effect','restyle_caption_track','separate_audio_to_new_track','set_composition',
    'set_role_gain','split_layer_grouped','trim_layer','update_effect','update_layer','update_layer_param_track',
    'update_layer_param_tracks','update_layer_params','update_project_settings','update_role_flags','update_track_flags',
  ].sort())
})
```

- [ ] **Step 2: Run the FULL state suite + typecheck**

Run: `npx vitest run src/main/state` and `npx tsc -p tsconfig.main.json --noEmit`
Expected: every gate green — `commands.differential`, `differential.phase2`, `summary.differential`, `persistence.differential`, all unit suites; `tsc` clean. Confirm `git status` shows only NEW files under `fixtures/state-corpus/sequences-prod` + `oracle-prod` (no modified pre-existing oracles).

- [ ] **Step 3: Document the new corpus dimension**

In `fixtures/state-corpus/README.md`, add a section: the `sequences-prod/` + `oracle-prod/` dimension drives the REAL Rust `Backend::dispatch` (production channel parsing) under det ids vs the TS `actor.command` adapter; list the in-scope channel set and the explicitly-deferred-to-3d channels (markers, transitions, group-member ops, delete/move_track, add_caption_track, project_restore_checkpoint) with the one-line reason each (MCP-only / no TS checkpoint infra).

- [ ] **Step 4: Commit**

```bash
git add src/main/state/__tests__/commands.test.ts fixtures/state-corpus/README.md
git commit -m "test(state-migration): production adapter coverage audit + corpus docs (Phase 3c-ii-a)"
```

---

## Self-review notes (carry into execution)

- **Confirm-against-code items (the gate backstops, but verify to save iterations):** exact arg-struct field names (`commands/mod.rs`); `add_color_layer`/`add_text_layer` default track + default duration; `add_media_layer` `total_src`/`image_layer_span_us`/auto-pair predicate + setting source + id-allocation order (`mutations.rs`); patch wire shapes (`renderer/ipc/index.ts`); `EventSink` trait signature + `napi_backend` module visibility for the `pub use`.
- **`resolveDurationUs`/`resolveDefaultTrack`** (Task 3 Step 4) encapsulate Rust's absent-arg fallbacks (default duration constant; default track when `trackId` omitted). Fill both from `mutations.rs` Step-1 findings; the gate confirms.
- **Out-of-scope is deliberate:** markers/transitions/group-member ops/track delete-move/add_caption_track/restore_checkpoint are NOT renderer channels (or lack TS infra) → 3d. The existing replay differential already gates their mutation engine.
- **Next slice:** 3c-ii-b (persistence re-home + napi boundary).
