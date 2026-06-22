# State-Actor TS Migration — Phase 2b-ii Plan (ref-capture generalization + markers + group-membership + custom tracks + track flags)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the SECOND slice of **Phase 2b** of the master plan `2026-06-22-state-actor-ts-migration.md`. Read the **Phase-2b-i plan** (`…-phase-2b-i.md`) first — it ported `update_layer` + `fit_composition_to_layers` and proved the oracle-regeneration workflow. This slice is the "bigger lift": it generalizes the Rust driver's ref-capture (the keystone) and then lights up the remaining recorded mutations that need an addressable id.

**Goal:** Generalize the Rust `replay_driver`'s ref-capture so every id-returning op (`add_track`, `add_marker`, `duplicate_layer`, `groups_create`) can be addressed by later commands — then port/wire and differential-gate: the **group-membership** family (`groups_dissolve`/`add_members`/`remove_members`/`rename`), **markers** (`update_marker`/`remove_marker`), **custom-track** ops (`delete_track`/`move_track`), and the **unrecorded track-flag setter** (`update_track_flags`, incl. the track-lock path that gates `TrackLocked`/`GroupLockedMember` in group fan-out).

**Architecture:** Same as Phase 1/2a/2b-i — pure functions over an Immer draft, 1:1 with Rust `apply_*`/`do_*`; the actor's `commit` runs validate→record→emit. Two ops deviate from the generic `commit` pipeline and need dedicated actor paths: `move_track` (a `cur===new` no-op must skip `commit` entirely — recording it would burn an op_id and drift every later entity id) and `update_track_flags` (UNRECORDED — `replaceTrackFlagsEverywhere` + `broadcastUnrecorded`, like `replace_settings_everywhere`). The differential corpus grows by ~24 sequences; the Rust `replay_driver` gains arms; the TS gate (`differential.phase2.test.ts`) auto-picks-up new sequences once vocabulary + oracles exist.

**Tech Stack:** TypeScript, Immer, Vitest, the `weftcut-eval` wasm leaf (`snapFrameRound`, UNCHANGED), the Rust `replay_driver` bin + `gen-state-oracle.mjs` (needs the cargo/ffmpeg toolchain).

## Global Constraints

- **The oracle-regeneration toolchain (verified working 2026-06-22).** Regenerating oracles builds `replay_driver` (compiles the native crate incl. ffmpeg-next). Set these env vars before any `cargo`/regen, then run from `apps/desktop/`:
  ```bash
  export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
  export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
  export PATH="$FFMPEG_DIR/bin:$PATH"
  node scripts/gen-state-oracle.mjs   # builds replay_driver, runs each sequence 2× (determinism gate), writes oracle/*.json
  ```
  The build feature set is baked into `gen-state-oracle.mjs` (`--features replay,jobs,export,mcp,cloud,motifs`; bare `replay` fails on a pre-existing `napi_backend.rs` error). **Every driver change in this slice is ADDITIVE** — after a regen, the **69 pre-existing oracles must be byte-identical**; only NEW oracle files may appear. Verify with `git status --short fixtures/state-corpus/oracle/` after each regen (only `??` new files, never `M`). If an existing oracle shows Modified, STOP — the change wasn't additive; investigate.
- **Baseline:** the corpus currently holds **69 sequences / 69 oracles**; `differential.phase2.test.ts` runs all 69 with `skipped === []`.
- **Gate-ordering invariant (why task order matters).** `differential.phase2.test.ts` asserts `skipped === []` over the LIVE corpus dir, and `gen-state-oracle.mjs` runs the Rust driver over the LIVE corpus dir. So for any new op X: X must be in TS `SUPPORTED_OPS` + `buildArgs` + a dispatch arm + (if recorded) its mutation, AND in the Rust driver's `apply()`, **before** any corpus sequence using X exists. Never add a corpus sequence whose op isn't already supported on BOTH sides.
- **`move_track` no-op skips `commit`** (`do_move_track`, actor.rs:3412-3414): when `cur_idx === new_position`, Rust returns `Ok(())` WITHOUT committing — no history entry, no `op_id`. The TS actor's generic `commit` always records + burns an `idGen()`. Since op_ids and entity ids share the one deterministic counter, a spurious recorded no-op would shift every later entity id and break the gate. The actor MUST detect the no-op before `commit`. (Dedicated `moveTrack` path — Task 6.)
- **`update_track_flags` is UNRECORDED** (`do_update_track_flags`, actor.rs:3637-3650): `TrackNotFound` check on the current snapshot FIRST, then `replace_track_flags_everywhere` (patches every snapshot + checkpoint where the track exists; only `Some(_)` fields apply), then `broadcast_unrecorded` (which burns ONE id — mirror with `broadcastUnrecorded` so the counter stays aligned). Ctrl-Z never reverts it. (Dedicated `updateTrackFlags` path — Task 8.) This is the [[project_settings_patch_convention]] pattern.
- **Patch fields apply only when present** (`MarkerPatch` actor.rs:288-301, `TrackFlagsPatch` project.rs:151-162): serde treats `null`/absent as `None` (skip). Mirror with `typeof` guards. **`MarkerPatch.end_t_us` can only be SET, never cleared** to null (`if let Some(end) = patch.end_t_us { m.end_t_us = Some(end) }`) — clearing a region round-trips through remove+add.
- **`update_marker` re-sorts markers by `t_us` (stable) only when `t_us` changed** (actor.rs:3165-3171), preserving the sorted-markers invariant. JS `Array.prototype.sort` is stable (ES2019+).
- **`delete_track`**: `TrackNotFound` → `TrackNotRemovable` (reserved `@A`/`@B` have `removable:false`) → `TrackNotEmpty` (unless `force`) → splice (recorded). Deleting a track whose layers are group members leaves dangling members → `ValidationFailed(GroupMemberMissing)`; keep `delete_track` corpus layers ungrouped.
- **The wasm snap leaf is sacred** — never reimplemented.
- **id contract (unchanged):** `commit` allocates the op_id AFTER `validate`; a successful recorded op burns one op_id; a failed validate burns none; `broadcastUnrecorded`/undo/redo each burn one id. None of these ops allocate an entity id except via their own `idGen()` calls inside the (pre-existing) add mutations.
- **`CommandError` variant names match Rust** — `TrackNotFound`, `TrackNotRemovable`, `TrackNotEmpty`, `TrackPositionOutOfRange`, `TrackLocked`, `MarkerNotFound`, `GroupNotFound`, `LayerNotInGroup`, `LayerAlreadyGrouped`, `GroupLockedMember` — all already in `errors.ts`.
- **TimeUs is `number`.** Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `git add` by **explicit path only** (parallel sessions — [[feedback_parallel_sessions_git]]). Work on local `main`; do NOT push. TDD, frequent commits, DRY, YAGNI.

### Reference Rust sources (cite; re-read only if a differential step diverges)

Driver: `native/src/bin/replay_driver.rs` (`apply()` match, `resolve_id`, ref-capture in add_layer arm). Handles + `do_*`: `groups_dissolve`/`add_members`/`remove_members`/`rename` (actor.rs:1593-1663 handles; `apply_groups_*` in mutations.rs:221-319), `update_marker`/`remove_marker` (handles actor.rs:1504-1530; `do_update_marker`/`do_remove_marker` actor.rs:3137-3198; `MarkerPatch` actor.rs:288-301), `delete_track`/`move_track` (handles actor.rs:1048-1065/1665-1682; `do_delete_track` actor.rs:2622-2649; `do_move_track` actor.rs:3394-3426), `update_track_flags` (handle actor.rs:1421-1438; `do_update_track_flags` actor.rs:3637-3650; `TrackFlagsPatch` project.rs:151-162; `replace_track_flags_everywhere` history.rs:281-292). TS group mutations already exist: `mutations/groups.ts` (`applyGroupsDissolve`/`AddMembers`/`RemoveMembers`/`Rename`); dispatch arms already exist: `actor.ts:192-195`.

---

## File Structure

All paths under `apps/desktop/`. Vitest from `apps/desktop/` (`npx vitest run <path>`).

| Path | Responsibility | New/Mod |
|---|---|---|
| `native/src/bin/replay_driver.rs` | Generalize ref-capture (`apply()` → `Result<Option<String>, String>`, capture in main loop); add `groups_add_members`/`remove_members`/`rename`, `update_marker`/`remove_marker`, `delete_track`/`move_track`, `update_track_flags` arms. | Mod |
| `src/main/state/mutations/markers.ts` | `MarkerPatch`, `applyUpdateMarker`, `applyRemoveMarker`. | **New** |
| `src/main/state/mutations/tracks.ts` | `applyDeleteTrack`, `applyMoveTrack`. | **New** |
| `src/main/state/history.ts` | `TrackFlagsPatch` type + `replaceTrackFlagsEverywhere(trackId, patch)`. | Mod |
| `src/main/state/actor.ts` | Dispatch arms: markers update/remove; `delete_track`; dedicated `moveTrack` (no-op) + `updateTrackFlags` (unrecorded). Imports. | Mod |
| `src/main/state/replay.ts` | `SUPPORTED_OPS` + `buildArgs` for all 9 new ops. | Mod |
| `fixtures/state-corpus/sequences/*.json` | ~24 new sequences. | **New** |
| `fixtures/state-corpus/oracle/*.json` | Regenerated oracle traces (generated). | **New (generated)** |
| `fixtures/state-corpus/README.md` | Move closed gaps (#1,#2,#3,#4) into the coverage table. | Mod |

---

## Task 1: Generalize the Rust driver's ref-capture (keystone)

**Files:**
- Modify: `native/src/bin/replay_driver.rs`

**Interfaces:**
- Produces: every id-returning op (`add_layer`, `add_track`, `add_marker`, `duplicate_layer`, `groups_create`) captures its result under the command's `ref`; `apply()` returns `Result<Option<String>, String>` (`Some(id)` when the op produced one, `None` otherwise). This unlocks addressing groups/tracks/markers in every later task. No new ops, no new sequences.

- [ ] **Step 1: Rewrite `apply()`'s signature + every arm + the main-loop capture.**

In `native/src/bin/replay_driver.rs`, change the main loop's per-command body to capture generically (the only behavioral change is *where* refs are inserted — state output is unaffected, so oracles stay byte-identical):

```rust
    let mut steps = Vec::new();
    for cmd in seq["commands"].as_array().unwrap() {
        let op = cmd["op"].as_str().unwrap().to_string();
        let outcome = apply(&h, cmd, &refs).await;
        let (ok, error) = match &outcome { Ok(_) => (true, None), Err(e) => (false, Some(e.clone())) };
        if let Ok(Some(id)) = &outcome {
            if let Some(rf) = cmd["ref"].as_str() { refs.insert(rf.to_string(), id.clone()); }
        }
        let snap = h.snapshot().await;
        steps.push(json!({ "op": op, "ok": ok, "error": error, "state": canonical_state(&snap) }));
    }
```

Change `apply`'s signature to take `refs` immutably and return an optional id (the inline ref-capture moves out of the `add_layer` arm into the loop above):

```rust
async fn apply(h: &ProjectHandle, cmd: &Value, refs: &HashMap<String, String>) -> Result<Option<String>, String> {
    let op = cmd["op"].as_str().unwrap();
    let u = Actor::User;
    let r = |c: &Value, k: &str| c[k].as_i64().unwrap();
    match op {
        "add_layer" => {
            let track = resolve_id(refs, cmd["track"].as_str().unwrap());
            let params = match cmd["kind"].as_str().unwrap() {
                "color" => LayerParams::Color(ColorParams {
                    color: Animated::Static(Rgba { r: 255, g: 0, b: 0, a: 255 }),
                    width: 1920, height: 1080,
                }),
                "text" => default_text_params(),
                other => return Err(format!("unknown kind {other}")),
            };
            h.add_layer(u, track, params, r(cmd, "t_start_us"), r(cmd, "t_end_us")).await
                .map(|lid| Some(lid.to_string())).map_err(|e| format!("{e:?}"))
        }
        "add_track" => h.add_track(u, cmd["label"].as_str().map(str::to_string)).await
            .map(|tid| Some(tid.to_string())).map_err(|e| format!("{e:?}")),
        "move_layer" => h.move_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), resolve_id(refs, cmd["to_track"].as_str().unwrap()), r(cmd, "t_start_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "trim_layer" => {
            let edge = if cmd["edge"].as_str() == Some("out") { LayerEdge::Out } else { LayerEdge::In };
            h.trim_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), edge, r(cmd, "new_t_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "delete_layer" => h.delete_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "duplicate_layer" => h.duplicate_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), r(cmd, "t_offset_us")).await
            .map(|nid| Some(nid.to_string())).map_err(|e| format!("{e:?}")),
        "split_layer" => h.split_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), r(cmd, "at_t_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "groups_create" => {
            let ids: Vec<_> = cmd["layers"].as_array().unwrap().iter().map(|t| resolve_id(refs, t.as_str().unwrap())).collect();
            h.groups_create(u, ids, cmd["label"].as_str().map(str::to_string), cmd["reassign"].as_bool().unwrap_or(false)).await
                .map(|gid| Some(gid.to_string())).map_err(|e| format!("{e:?}"))
        }
        "groups_dissolve" => h.groups_dissolve(u, resolve_id(refs, cmd["group"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "add_marker" => h.add_marker(u, r(cmd, "t_us"), cmd["end_t_us"].as_i64(), cmd["label"].as_str().unwrap_or("m"), Rgba { r: 0, g: 128, b: 255, a: 255 }).await
            .map(|mid| Some(mid.to_string())).map_err(|e| format!("{e:?}")),
        "set_composition" => {
            let patch = CompositionPatch { duration_us: cmd["duration_us"].as_i64(), ..Default::default() };
            h.set_composition(u, patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_layer" => {
            let patch = LayerPatch {
                label: cmd["label"].as_str().map(str::to_string),
                t_start_us: cmd["t_start_us"].as_i64(),
                t_end_us: cmd["t_end_us"].as_i64(),
                enabled: cmd["enabled"].as_bool(),
                locked: cmd["locked"].as_bool(),
            };
            h.update_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "fit_composition_to_layers" => h.fit_composition_to_layers(u).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "undo" => h.undo(u).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "redo" => h.redo(u).await.map(|_| None).map_err(|e| format!("{e:?}")),
        other => Err(format!("driver: unsupported op {other}")),
    }
}
```

(`split_layer` returns a `(LayerId, LayerId)` tuple — like the TS side, which returns a `{left,right}` object that its `typeof === 'string'` capture guard skips, the driver returns `None` so neither side captures a split ref. Symmetric.)

- [ ] **Step 2: Regenerate oracles — assert the 69 existing are byte-identical.**

```bash
# from apps/desktop/ — env vars per Global Constraints
node scripts/gen-state-oracle.mjs
git status --short fixtures/state-corpus/oracle/
```
Expected: `ok  <name>` for all 69, exit 0; `git status` shows **NO modified oracle files** (the ref-capture move is state-neutral). If any oracle is Modified, STOP and investigate.

- [ ] **Step 3: Run the differential gate (still 69/69).**

`npx vitest run src/main/state/__tests__/differential.phase2.test.ts`
Expected: PASS, 69 sequences, `skipped === []` (no new ops, no new sequences — pure driver refactor).

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/native/src/bin/replay_driver.rs
git commit -m "refactor(state-migration): generalize replay-driver ref-capture (Phase 2b-ii)"
```

---

## Task 2: Group-membership family — vocabulary + driver arms + corpus

The TS mutations (`applyGroupsDissolve`/`AddMembers`/`RemoveMembers`/`Rename`) and the actor dispatch arms (`actor.ts:192-195`) ALREADY exist (dead code since Phase 2a). This task lights them up: TS vocabulary, the 3 missing driver arms (`groups_dissolve` already exists in the driver), corpus, oracles.

**Files:**
- Modify: `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`
- Test: `src/main/state/actor.test.ts` (add cases), corpus sequences
- Modify: `fixtures/state-corpus/{sequences,oracle}/`

**Interfaces:**
- Consumes: the pre-existing dispatch arms (`groups_dissolve`/`add_members`/`remove_members`/`rename`) and `applyGroups*` mutations; generalized ref-capture (Task 1) so `groups_create … "ref":"G1"` is addressable.
- Produces: `SUPPORTED_OPS` gains the 4 group ops; `buildArgs` resolves `group`/`layers` refs; driver gains `groups_add_members`/`remove_members`/`rename`.

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts`:

```ts
describe('dispatch: group-membership family', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'g'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const mk = (t0: number, t1: number) => (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: t0, t_end_us: t1 }) as { ok: true; value: string }).value
    return { actor, mk }
  }
  it('add_members then remove_members (auto-dissolve below 2)', () => {
    const { actor, mk } = setup()
    const l1 = mk(0, 1_000_000), l2 = mk(2_000_000, 3_000_000), l3 = mk(4_000_000, 5_000_000)
    const g = (actor.dispatch('groups_create', { layers: [l1, l2] }) as { ok: true; value: string }).value
    expect(actor.dispatch('groups_add_members', { group: g, layers: [l3] }).ok).toBe(true)
    expect(actor.snapshot().groups[0].members).toEqual([l1, l2, l3].sort())
    expect(actor.dispatch('groups_remove_members', { group: g, layers: [l2, l3] }).ok).toBe(true)
    expect(actor.snapshot().groups.length).toBe(0) // dropped below 2 → auto-dissolved
  })
  it('rename then dissolve', () => {
    const { actor, mk } = setup()
    const l1 = mk(0, 1_000_000), l2 = mk(2_000_000, 3_000_000)
    const g = (actor.dispatch('groups_create', { layers: [l1, l2] }) as { ok: true; value: string }).value
    expect(actor.dispatch('groups_rename', { group: g, label: 'scene' }).ok).toBe(true)
    expect(actor.snapshot().groups[0].label).toBe('scene')
    expect(actor.dispatch('groups_dissolve', { group: g }).ok).toBe(true)
    expect(actor.snapshot().groups.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (the dispatch arms exist, but `dispatch` is callable; these tests should actually PASS for dispatch since arms exist — if so, treat Step 1 as a characterization test confirming the pre-wired arms work, and move on). The genuine gap is the replay vocabulary + driver; the corpus (Step 5) is the real new coverage.

- [ ] **Step 3: Wire `replay.ts` vocabulary + `buildArgs`.** Add to `SUPPORTED_OPS`: `'groups_dissolve', 'groups_add_members', 'groups_remove_members', 'groups_rename'`. Add `buildArgs` cases:

```ts
    case 'groups_dissolve': return { group: resolve(refs, cmd.group) }
    case 'groups_add_members': return { group: resolve(refs, cmd.group), layers: (cmd.layers as unknown[]).map((t) => resolve(refs, t)), reassign: cmd.reassign ?? false }
    case 'groups_remove_members': return { group: resolve(refs, cmd.group), layers: (cmd.layers as unknown[]).map((t) => resolve(refs, t)) }
    case 'groups_rename': return { group: resolve(refs, cmd.group), label: cmd.label ?? null }
```

- [ ] **Step 4: Add the 3 driver arms** (`groups_dissolve` already exists at the current `apply()` match). Insert before the `other =>` arm in `native/src/bin/replay_driver.rs`:

```rust
        "groups_add_members" => {
            let ids: Vec<_> = cmd["layers"].as_array().unwrap().iter().map(|t| resolve_id(refs, t.as_str().unwrap())).collect();
            h.groups_add_members(u, resolve_id(refs, cmd["group"].as_str().unwrap()), ids, cmd["reassign"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "groups_remove_members" => {
            let ids: Vec<_> = cmd["layers"].as_array().unwrap().iter().map(|t| resolve_id(refs, t.as_str().unwrap())).collect();
            h.groups_remove_members(u, resolve_id(refs, cmd["group"].as_str().unwrap()), ids).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "groups_rename" => h.groups_rename(u, resolve_id(refs, cmd["group"].as_str().unwrap()), cmd["label"].as_str().map(str::to_string)).await.map(|_| None).map_err(|e| format!("{e:?}")),
```

- [ ] **Step 5: Author the corpus sequences** under `fixtures/state-corpus/sequences/` (group ids now addressable via Task 1):

`groups-dissolve-explicit.json`
```json
{ "name": "groups-dissolve-explicit", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "groups_create", "layers": ["@L1", "@L2"], "ref": "G1" },
  { "op": "groups_dissolve", "group": "@G1" }
] }
```
`groups-add-members.json`
```json
{ "name": "groups-add-members", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 4000000, "t_end_us": 5000000, "ref": "L3" },
  { "op": "groups_create", "layers": ["@L1", "@L2"], "ref": "G1" },
  { "op": "groups_add_members", "group": "@G1", "layers": ["@L3"] }
] }
```
`groups-remove-members-stays.json`
```json
{ "name": "groups-remove-members-stays", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 4000000, "t_end_us": 5000000, "ref": "L3" },
  { "op": "groups_create", "layers": ["@L1", "@L2", "@L3"], "ref": "G1" },
  { "op": "groups_remove_members", "group": "@G1", "layers": ["@L3"] }
] }
```
`groups-remove-members-auto-dissolve.json`
```json
{ "name": "groups-remove-members-auto-dissolve", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 4000000, "t_end_us": 5000000, "ref": "L3" },
  { "op": "groups_create", "layers": ["@L1", "@L2", "@L3"], "ref": "G1" },
  { "op": "groups_remove_members", "group": "@G1", "layers": ["@L2", "@L3"] }
] }
```
`groups-rename.json`
```json
{ "name": "groups-rename", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "groups_create", "layers": ["@L1", "@L2"], "ref": "G1" },
  { "op": "groups_rename", "group": "@G1", "label": "scene-1" }
] }
```
`groups-rename-clear.json`
```json
{ "name": "groups-rename-clear", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "groups_create", "layers": ["@L1", "@L2"], "label": "keep", "ref": "G1" },
  { "op": "groups_rename", "group": "@G1" }
] }
```
`group-locked-member-reject.json` (gates `GroupLockedMember` via the real layer-lock setter)
```json
{ "name": "group-locked-member-reject", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "groups_create", "layers": ["@L1", "@L2"], "ref": "G1" },
  { "op": "update_layer", "layer": "@L2", "locked": true },
  { "op": "move_layer", "layer": "@L1", "to_track": "@A", "t_start_us": 5000000, "escape_group": false }
] }
```

- [ ] **Step 6: Regenerate oracles + run the gate.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the 7 new oracle files as ?? — no M
npx vitest run src/main/state/actor.test.ts src/main/state/__tests__/differential.phase2.test.ts
```
Expected: gate PASS at 76 sequences (69 + 7), `skipped === []`. If a sequence diverges, debug the TS path against the cited Rust; do NOT edit the oracle/gate.

- [ ] **Step 7: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/groups-dissolve-explicit.json apps/desktop/fixtures/state-corpus/sequences/groups-add-members.json apps/desktop/fixtures/state-corpus/sequences/groups-remove-members-stays.json apps/desktop/fixtures/state-corpus/sequences/groups-remove-members-auto-dissolve.json apps/desktop/fixtures/state-corpus/sequences/groups-rename.json apps/desktop/fixtures/state-corpus/sequences/groups-rename-clear.json apps/desktop/fixtures/state-corpus/sequences/group-locked-member-reject.json apps/desktop/fixtures/state-corpus/oracle/groups-dissolve-explicit.json apps/desktop/fixtures/state-corpus/oracle/groups-add-members.json apps/desktop/fixtures/state-corpus/oracle/groups-remove-members-stays.json apps/desktop/fixtures/state-corpus/oracle/groups-remove-members-auto-dissolve.json apps/desktop/fixtures/state-corpus/oracle/groups-rename.json apps/desktop/fixtures/state-corpus/oracle/groups-rename-clear.json apps/desktop/fixtures/state-corpus/oracle/group-locked-member-reject.json
git commit -m "test(state-migration): group-membership family live + corpus (Phase 2b-ii)"
```

---

## Task 3: Markers — TS mutations (`markers.ts`)

**Files:**
- Create: `src/main/state/mutations/markers.ts`
- Test: `src/main/state/mutations/markers.test.ts`

**Interfaces:**
- Produces: `MarkerPatch` type; `applyUpdateMarker(p: Project, id: Uuid, patch: MarkerPatch): void`; `applyRemoveMarker(p: Project, id: Uuid): void`.
- Consumes: `applyAddMarker` from `./add` (existing) for test setup; `CommandFailure` from `../errors`.

- [ ] **Step 1: Write the failing tests** (`src/main/state/mutations/markers.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddMarker } from './add'
import { applyUpdateMarker, applyRemoveMarker } from './markers'
import { isCommandFailure } from '../errors'

function withMarkers(specs: Array<[number, number | null]>): { p: Project; ids: string[] } {
  const gen = seededGen(); const p = blankProject(gen, 't'); const ids: string[] = []
  for (const [t0, end] of specs) ids.push(applyAddMarker(p, gen, t0, end, 'm', { r: 0, g: 128, b: 255, a: 255 }))
  return { p, ids }
}
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }

describe('applyUpdateMarker', () => {
  it('patches label/end_t_us/color without touching t_us (no re-sort)', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { label: 'chapter', end_t_us: 2_000_000, color: { r: 255, g: 0, b: 0, a: 255 } })
    const m = p.markers[0]
    expect(m.label).toBe('chapter'); expect(m.end_t_us).toBe(2_000_000); expect(m.color.r).toBe(255)
    expect(m.t_us).toBe(1_000_000)
  })
  it('re-sorts markers by t_us when t_us changes (stable)', () => {
    const { p, ids } = withMarkers([[1_000_000, null], [2_000_000, null], [3_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: 5_000_000 })
    expect(p.markers.map((m) => m.t_us)).toEqual([2_000_000, 3_000_000, 5_000_000])
  })
  it('null/absent patch fields are "do not touch"', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: null, label: null })
    expect(p.markers[0].t_us).toBe(1_000_000); expect(p.markers[0].label).toBe('m')
  })
  it('throws MarkerNotFound for a missing marker', () => {
    const { p } = withMarkers([[1_000_000, null]])
    expectCmd(() => applyUpdateMarker(p, 'ghost', { label: 'x' }), 'MarkerNotFound')
  })
})

describe('applyRemoveMarker', () => {
  it('removes a marker by id', () => {
    const { p, ids } = withMarkers([[1_000_000, null], [2_000_000, null]])
    applyRemoveMarker(p, ids[0])
    expect(p.markers.map((m) => m.t_us)).toEqual([2_000_000])
  })
  it('throws MarkerNotFound for a missing marker', () => {
    const { p } = withMarkers([[1_000_000, null]])
    expectCmd(() => applyRemoveMarker(p, 'ghost'), 'MarkerNotFound')
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/main/state/mutations/markers.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`src/main/state/mutations/markers.ts`):

```ts
import type { Project, Rgba, Uuid } from '../model'
import { CommandFailure } from '../errors'

/** Mirrors native/src/state/actor.rs:288-301 MarkerPatch. null/absent = "don't
 *  touch"; end_t_us can only be SET, never cleared (clearing → remove+add). */
export interface MarkerPatch {
  t_us?: number | null
  end_t_us?: number | null
  label?: string | null
  color?: Rgba | null
}

/** actor.rs:3137-3180 — patch a marker; only provided fields apply. Re-sorts by
 *  t_us (stable) when t_us changed, preserving the sorted-markers invariant. */
export function applyUpdateMarker(p: Project, id: Uuid, patch: MarkerPatch): void {
  const idx = p.markers.findIndex((m) => m.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'MarkerNotFound', marker: id })
  const needsResort = typeof patch.t_us === 'number'
  const m = p.markers[idx]
  if (typeof patch.t_us === 'number') m.t_us = patch.t_us
  if (typeof patch.end_t_us === 'number') m.end_t_us = patch.end_t_us
  if (typeof patch.label === 'string') m.label = patch.label
  if (patch.color && typeof patch.color === 'object') m.color = patch.color
  if (needsResort) p.markers.sort((a, b) => (a.t_us < b.t_us ? -1 : a.t_us > b.t_us ? 1 : 0))
}

/** actor.rs:3182-3198 — remove a marker by id. */
export function applyRemoveMarker(p: Project, id: Uuid): void {
  const idx = p.markers.findIndex((m) => m.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'MarkerNotFound', marker: id })
  p.markers.splice(idx, 1)
}
```

- [ ] **Step 4: Run to verify they pass** — same command → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/markers.ts apps/desktop/src/main/state/mutations/markers.test.ts
git commit -m "feat(state-migration): applyUpdateMarker + applyRemoveMarker (Phase 2b-ii)"
```

---

## Task 4: Markers — dispatch + vocabulary + driver + corpus

**Files:**
- Modify: `src/main/state/actor.ts`, `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`
- Test: `src/main/state/actor.test.ts`, corpus sequences

**Interfaces:**
- Consumes: `applyUpdateMarker`, `applyRemoveMarker`, `MarkerPatch` from `./mutations/markers`.
- Produces: dispatch handles `update_marker` + `remove_marker`; `SUPPORTED_OPS`/`buildArgs` gain both; driver gains both arms.

- [ ] **Step 1: Add failing dispatch test** to `src/main/state/actor.test.ts`:

```ts
describe('dispatch: update_marker + remove_marker', () => {
  it('updates then removes a marker', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'm')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const m = (actor.dispatch('add_marker', { t_us: 1_000_000 }) as { ok: true; value: string }).value
    expect(actor.dispatch('update_marker', { marker: m, patch: { label: 'chapter', end_t_us: 2_000_000 } }).ok).toBe(true)
    const snap = actor.snapshot()
    expect(snap.markers[0].label).toBe('chapter'); expect(snap.markers[0].end_t_us).toBe(2_000_000)
    expect(actor.dispatch('remove_marker', { marker: m }).ok).toBe(true)
    expect(actor.snapshot().markers.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops).

- [ ] **Step 3: Wire `actor.ts`.** Add the import and two dispatch arms (after the `update_layer` arm):

```ts
import { applyUpdateMarker, applyRemoveMarker, type MarkerPatch } from './mutations/markers'
```
```ts
        case 'update_marker': commit('Updated marker', [{ kind: 'Marker', id: a.marker as Uuid }], { kind: 'Coarse' }, (d) => applyUpdateMarker(d, a.marker as Uuid, a.patch as MarkerPatch)); return { ok: true, value: null }
        case 'remove_marker': commit('Removed marker', [{ kind: 'Marker', id: a.marker as Uuid }], { kind: 'Coarse' }, (d) => applyRemoveMarker(d, a.marker as Uuid)); return { ok: true, value: null }
```

- [ ] **Step 4: Wire `replay.ts`.** Add `'update_marker', 'remove_marker'` to `SUPPORTED_OPS`; add `buildArgs` cases:

```ts
    case 'update_marker': return { marker: resolve(refs, cmd.marker), patch: { t_us: cmd.t_us, end_t_us: cmd.end_t_us, label: cmd.label, color: cmd.color } }
    case 'remove_marker': return { marker: resolve(refs, cmd.marker) }
```
(Marker `color` patches are not exercised by the corpus this slice — the driver doesn't parse a color object — so corpus sequences omit `color`; the TS `color` path is unit-tested in Task 3. Documented in the README gap note.)

- [ ] **Step 5: Add the 2 driver arms** before the `other =>` arm in `replay_driver.rs`:

```rust
        "update_marker" => {
            let patch = weftcut_lib::state::actor::MarkerPatch {
                t_us: cmd["t_us"].as_i64(),
                end_t_us: cmd["end_t_us"].as_i64(),
                label: cmd["label"].as_str().map(str::to_string),
                color: None,
            };
            h.update_marker(u, resolve_id(refs, cmd["marker"].as_str().unwrap()), patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "remove_marker" => h.remove_marker(u, resolve_id(refs, cmd["marker"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
```
(Extend the top `use weftcut_lib::state::actor::{...}` line to include `MarkerPatch`, or reference it fully-qualified as above.)

- [ ] **Step 6: Author the corpus sequences** (marker ids addressable via Task 1):

`update-marker-label.json`
```json
{ "name": "update-marker-label", "commands": [
  { "op": "add_marker", "t_us": 1000000, "ref": "M1" },
  { "op": "update_marker", "marker": "@M1", "label": "chapter" }
] }
```
`update-marker-region.json`
```json
{ "name": "update-marker-region", "commands": [
  { "op": "add_marker", "t_us": 1000000, "ref": "M1" },
  { "op": "update_marker", "marker": "@M1", "end_t_us": 2000000 }
] }
```
`update-marker-time-resort.json`
```json
{ "name": "update-marker-time-resort", "commands": [
  { "op": "add_marker", "t_us": 1000000, "ref": "M1" },
  { "op": "add_marker", "t_us": 2000000, "ref": "M2" },
  { "op": "add_marker", "t_us": 3000000, "ref": "M3" },
  { "op": "update_marker", "marker": "@M1", "t_us": 5000000 }
] }
```
`remove-marker.json`
```json
{ "name": "remove-marker", "commands": [
  { "op": "add_marker", "t_us": 1000000, "ref": "M1" },
  { "op": "add_marker", "t_us": 2000000, "ref": "M2" },
  { "op": "remove_marker", "marker": "@M1" }
] }
```
`marker-remove-then-update-notfound.json` (real-but-absent id → `MarkerNotFound`; gates remove success + update-not-found without a non-uuid token)
```json
{ "name": "marker-remove-then-update-notfound", "commands": [
  { "op": "add_marker", "t_us": 1000000, "ref": "M1" },
  { "op": "remove_marker", "marker": "@M1" },
  { "op": "update_marker", "marker": "@M1", "label": "x" }
] }
```

- [ ] **Step 7: Regenerate oracles + run the gate.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the 5 new oracle files as ??
npx vitest run src/main/state/actor.test.ts src/main/state/__tests__/differential.phase2.test.ts
```
Expected: gate PASS at 81 sequences (76 + 5), `skipped === []`.

- [ ] **Step 8: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/update-marker-label.json apps/desktop/fixtures/state-corpus/sequences/update-marker-region.json apps/desktop/fixtures/state-corpus/sequences/update-marker-time-resort.json apps/desktop/fixtures/state-corpus/sequences/remove-marker.json apps/desktop/fixtures/state-corpus/sequences/marker-remove-then-update-notfound.json apps/desktop/fixtures/state-corpus/oracle/update-marker-label.json apps/desktop/fixtures/state-corpus/oracle/update-marker-region.json apps/desktop/fixtures/state-corpus/oracle/update-marker-time-resort.json apps/desktop/fixtures/state-corpus/oracle/remove-marker.json apps/desktop/fixtures/state-corpus/oracle/marker-remove-then-update-notfound.json
git commit -m "test(state-migration): update_marker + remove_marker live + corpus (Phase 2b-ii)"
```

---

## Task 5: Custom tracks — TS mutations (`tracks.ts`)

**Files:**
- Create: `src/main/state/mutations/tracks.ts`
- Test: `src/main/state/mutations/tracks.test.ts`

**Interfaces:**
- Produces: `applyDeleteTrack(p: Project, id: Uuid, force: boolean): void`; `applyMoveTrack(p: Project, id: Uuid, newPosition: number): void`.
- Consumes: `applyAddTrack`, `applyAddLayer`, `colorParams` from `./add` (test setup); `CommandFailure` from `../errors`.

> `applyMoveTrack` performs validation + a remove/reinsert splice. The `cur===new` NO-OP short-circuit (skip `commit`) lives in the **actor** (Task 6), NOT here — `applyMoveTrack` for a no-op produces a state-identical array (remove then reinsert at the same index), so it's a pure helper.

- [ ] **Step 1: Write the failing tests** (`src/main/state/mutations/tracks.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddTrack, applyAddLayer, colorParams } from './add'
import { applyDeleteTrack, applyMoveTrack } from './tracks'
import { isCommandFailure } from '../errors'

function base(): { p: Project; gen: IdGen } { const gen = seededGen(); return { p: blankProject(gen, 't'), gen } }
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }

describe('applyDeleteTrack', () => {
  it('removes an empty custom track', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyDeleteTrack(p, t, false)
    expect(p.tracks.find((x) => x.id === t)).toBeUndefined()
  })
  it('rejects a reserved (non-removable) track', () => {
    const { p } = base()
    expectCmd(() => applyDeleteTrack(p, p.tracks[0].id, false), 'TrackNotRemovable')
  })
  it('rejects a non-empty track without force', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyAddLayer(p, gen, t, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    expectCmd(() => applyDeleteTrack(p, t, false), 'TrackNotEmpty')
  })
  it('force-deletes a non-empty track', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyAddLayer(p, gen, t, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyDeleteTrack(p, t, true)
    expect(p.tracks.find((x) => x.id === t)).toBeUndefined()
  })
  it('throws TrackNotFound for a missing track', () => {
    const { p } = base()
    expectCmd(() => applyDeleteTrack(p, 'ghost', false), 'TrackNotFound')
  })
})

describe('applyMoveTrack', () => {
  it('reorders a track to a new position', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra') // appended at idx 2
    applyMoveTrack(p, t, 0)
    expect(p.tracks[0].id).toBe(t)
  })
  it('throws TrackPositionOutOfRange when position >= len', () => {
    const { p } = base()
    expectCmd(() => applyMoveTrack(p, p.tracks[0].id, 9), 'TrackPositionOutOfRange')
  })
  it('throws TrackNotFound for a missing track', () => {
    const { p } = base()
    expectCmd(() => applyMoveTrack(p, 'ghost', 0), 'TrackNotFound')
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/main/state/mutations/tracks.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`src/main/state/mutations/tracks.ts`):

```ts
import type { Project, Uuid } from '../model'
import { CommandFailure } from '../errors'

/** actor.rs:2622-2649 — remove a track. TrackNotFound → TrackNotRemovable
 *  (reserved tracks) → TrackNotEmpty (unless force) → splice. */
export function applyDeleteTrack(p: Project, id: Uuid, force: boolean): void {
  const idx = p.tracks.findIndex((t) => t.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'TrackNotFound', track: id })
  if (!p.tracks[idx].removable) throw new CommandFailure({ error: 'TrackNotRemovable', track: id })
  if (!force && p.tracks[idx].layers.length > 0) throw new CommandFailure({ error: 'TrackNotEmpty', track: id })
  p.tracks.splice(idx, 1)
}

/** actor.rs:3394-3426 — reposition a track. TrackNotFound → TrackPositionOutOfRange
 *  → remove+reinsert. The cur===new no-op (skip commit) is handled by the actor. */
export function applyMoveTrack(p: Project, id: Uuid, newPosition: number): void {
  const cur = p.tracks.findIndex((t) => t.id === id)
  if (cur < 0) throw new CommandFailure({ error: 'TrackNotFound', track: id })
  if (newPosition >= p.tracks.length) throw new CommandFailure({ error: 'TrackPositionOutOfRange', position: newPosition, len: p.tracks.length })
  const [t] = p.tracks.splice(cur, 1)
  p.tracks.splice(newPosition, 0, t)
}
```

- [ ] **Step 4: Run to verify they pass** — same command → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/tracks.ts apps/desktop/src/main/state/mutations/tracks.test.ts
git commit -m "feat(state-migration): applyDeleteTrack + applyMoveTrack (Phase 2b-ii)"
```

---

## Task 6: Custom tracks — dispatch (incl. move no-op) + vocabulary + driver + corpus

**Files:**
- Modify: `src/main/state/actor.ts`, `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`
- Test: `src/main/state/actor.test.ts`, corpus sequences

**Interfaces:**
- Consumes: `applyDeleteTrack`, `applyMoveTrack` from `./mutations/tracks`.
- Produces: dispatch handles `delete_track` (via `commit`) + `move_track` (dedicated `moveTrack` with the no-op short-circuit); `SUPPORTED_OPS`/`buildArgs` gain both; driver gains both arms.

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts` (the no-op test is the critical one):

```ts
describe('dispatch: delete_track + move_track', () => {
  it('move_track no-op does NOT record (later entity ids unshifted)', () => {
    const idGenA = seededGen(); const a1 = createActor({ initial: blankProject(idGenA, 't'), idGen: idGenA, clock: () => '<TS>' })
    a1.dispatch('move_track', { track: a1.snapshot().tracks[0].id, new_position: 0 }) // no-op
    const idA = (a1.dispatch('add_layer', { track: a1.snapshot().tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    // A control actor that skips the no-op entirely must allocate the SAME layer id.
    const idGenB = seededGen(); const a2 = createActor({ initial: blankProject(idGenB, 't'), idGen: idGenB, clock: () => '<TS>' })
    const idB = (a2.dispatch('add_layer', { track: a2.snapshot().tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    expect(idA).toBe(idB) // no-op move burned no op_id
  })
  it('delete_track removes a custom track; move_track reorders', () => {
    const idGen = seededGen(); const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '<TS>' })
    const t = (actor.dispatch('add_track', { label: 'x' }) as { ok: true; value: string }).value
    expect(actor.dispatch('move_track', { track: t, new_position: 0 }).ok).toBe(true)
    expect(actor.snapshot().tracks[0].id).toBe(t)
    expect(actor.dispatch('delete_track', { track: t, force: false }).ok).toBe(true)
    expect(actor.snapshot().tracks.find((x) => x.id === t)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops).

- [ ] **Step 3: Wire `actor.ts`.** Add the import, a dedicated `moveTrack` closure function (next to `setComposition`/`undo`), and two dispatch arms:

```ts
import { applyDeleteTrack, applyMoveTrack } from './mutations/tracks'
```
```ts
  // ── move_track (do_move_track:3394-3426) — the cur===new no-op must skip
  //    commit; recording it would burn an op_id and drift every later id. ──
  function moveTrack(id: Uuid, newPosition: number): void {
    const curIdx = current().tracks.findIndex((t) => t.id === id)
    if (curIdx >= 0 && curIdx === newPosition) return // no-op: no record, no broadcast
    commit('Moved track', [{ kind: 'Track', id }], { kind: 'Coarse' }, (d) => applyMoveTrack(d, id, newPosition))
  }
```
Dispatch arms:
```ts
        case 'delete_track': commit('Deleted track', [{ kind: 'Track', id: a.track as Uuid }], { kind: 'Coarse' }, (d) => applyDeleteTrack(d, a.track as Uuid, (a.force as boolean) ?? false)); return { ok: true, value: null }
        case 'move_track': moveTrack(a.track as Uuid, a.new_position as number); return { ok: true, value: null }
```

- [ ] **Step 4: Wire `replay.ts`.** Add `'delete_track', 'move_track'` to `SUPPORTED_OPS`; add `buildArgs` cases:

```ts
    case 'delete_track': return { track: resolve(refs, cmd.track), force: cmd.force ?? false }
    case 'move_track': return { track: resolve(refs, cmd.track), new_position: cmd.new_position }
```

- [ ] **Step 5: Add the 2 driver arms** before the `other =>` arm in `replay_driver.rs`:

```rust
        "delete_track" => h.delete_track(u, resolve_id(refs, cmd["track"].as_str().unwrap()), cmd["force"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "move_track" => h.move_track(u, resolve_id(refs, cmd["track"].as_str().unwrap()), cmd["new_position"].as_u64().unwrap() as usize).await.map(|_| None).map_err(|e| format!("{e:?}")),
```

- [ ] **Step 6: Author the corpus sequences:**

`delete-track-custom.json`
```json
{ "name": "delete-track-custom", "commands": [
  { "op": "add_track", "label": "extra", "ref": "T1" },
  { "op": "delete_track", "track": "@T1" }
] }
```
`delete-track-reserved-reject.json`
```json
{ "name": "delete-track-reserved-reject", "commands": [
  { "op": "delete_track", "track": "@A" }
] }
```
`delete-track-not-empty-reject.json`
```json
{ "name": "delete-track-not-empty-reject", "commands": [
  { "op": "add_track", "label": "extra", "ref": "T1" },
  { "op": "add_layer", "track": "@T1", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "delete_track", "track": "@T1" }
] }
```
`delete-track-force.json`
```json
{ "name": "delete-track-force", "commands": [
  { "op": "add_track", "label": "extra", "ref": "T1" },
  { "op": "add_layer", "track": "@T1", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "delete_track", "track": "@T1", "force": true }
] }
```
`move-track-reorder.json`
```json
{ "name": "move-track-reorder", "commands": [
  { "op": "add_track", "label": "extra", "ref": "T1" },
  { "op": "move_track", "track": "@T1", "new_position": 0 }
] }
```
`move-track-out-of-range.json`
```json
{ "name": "move-track-out-of-range", "commands": [
  { "op": "move_track", "track": "@A", "new_position": 9 }
] }
```
`move-track-noop.json` (the no-op gate — a later entity id would drift if either side records the no-op)
```json
{ "name": "move-track-noop", "commands": [
  { "op": "move_track", "track": "@A", "new_position": 0 },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" }
] }
```
`move-track-to-custom-target.json` (gap #2 — a layer moved onto a user-created track)
```json
{ "name": "move-track-to-custom-target", "commands": [
  { "op": "add_track", "label": "extra", "ref": "T1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "move_layer", "layer": "@L1", "to_track": "@T1", "t_start_us": 0, "escape_group": false }
] }
```

- [ ] **Step 7: Regenerate oracles + run the gate.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the 8 new oracle files as ??
npx vitest run src/main/state/actor.test.ts src/main/state/__tests__/differential.phase2.test.ts
```
Expected: gate PASS at 89 sequences (81 + 8), `skipped === []`. The `move-track-noop` sequence's second step (add_layer) MUST yield a byte-identical layer id on both sides — if it diverges, the no-op handling burned an extra op_id somewhere; fix the actor's `moveTrack` short-circuit, not the oracle.

- [ ] **Step 8: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/delete-track-custom.json apps/desktop/fixtures/state-corpus/sequences/delete-track-reserved-reject.json apps/desktop/fixtures/state-corpus/sequences/delete-track-not-empty-reject.json apps/desktop/fixtures/state-corpus/sequences/delete-track-force.json apps/desktop/fixtures/state-corpus/sequences/move-track-reorder.json apps/desktop/fixtures/state-corpus/sequences/move-track-out-of-range.json apps/desktop/fixtures/state-corpus/sequences/move-track-noop.json apps/desktop/fixtures/state-corpus/sequences/move-track-to-custom-target.json apps/desktop/fixtures/state-corpus/oracle/delete-track-custom.json apps/desktop/fixtures/state-corpus/oracle/delete-track-reserved-reject.json apps/desktop/fixtures/state-corpus/oracle/delete-track-not-empty-reject.json apps/desktop/fixtures/state-corpus/oracle/delete-track-force.json apps/desktop/fixtures/state-corpus/oracle/move-track-reorder.json apps/desktop/fixtures/state-corpus/oracle/move-track-out-of-range.json apps/desktop/fixtures/state-corpus/oracle/move-track-noop.json apps/desktop/fixtures/state-corpus/oracle/move-track-to-custom-target.json
git commit -m "test(state-migration): delete_track + move_track live + corpus (Phase 2b-ii)"
```

---

## Task 7: `update_track_flags` primitive — `History.replaceTrackFlagsEverywhere`

**Files:**
- Modify: `src/main/state/history.ts`
- Test: `src/main/state/history.test.ts` (add cases — create the file if absent)

**Interfaces:**
- Produces: `TrackFlagsPatch` (exported from `history.ts`); `History.prototype.replaceTrackFlagsEverywhere(trackId: Uuid, patch: TrackFlagsPatch): void` — patches one track's flags into EVERY snapshot + checkpoint where the track exists; only `typeof`-defined fields apply; never records.

- [ ] **Step 1: Write the failing test.** Confirm the existing test path first: `ls src/main/state/history.test.ts` (if absent, create it with the imports below). Add:

```ts
import { describe, it, expect } from 'vitest'
import { History } from './history'
import { seededGen } from './ids'
import { blankProject } from './model'

describe('History.replaceTrackFlagsEverywhere', () => {
  it('patches all snapshots + persists across undo, unrecorded', () => {
    const gen = seededGen(); const p0 = blankProject(gen, 't'); const tid = p0.tracks[0].id
    const h = new History(p0, { kind: 'User' }, gen())
    // record a second snapshot so there's something to undo to
    const p1 = { ...h.current(), markers: [...h.current().markers] }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 'edit', affected: [], snapshot: p1 })
    h.replaceTrackFlagsEverywhere(tid, { locked: true })
    expect(h.current().tracks.find((t) => t.id === tid)!.locked).toBe(true)
    expect(h.len()).toBe(2) // not recorded
    const prev = h.undo()!
    expect(prev.tracks.find((t) => t.id === tid)!.locked).toBe(true) // persists across undo
  })
  it('only typeof-defined fields apply; absent track is skipped', () => {
    const gen = seededGen(); const p0 = blankProject(gen, 't'); const tid = p0.tracks[0].id
    const h = new History(p0, { kind: 'User' }, gen())
    h.replaceTrackFlagsEverywhere(tid, { muted: true })
    const t = h.current().tracks.find((x) => x.id === tid)!
    expect(t.muted).toBe(true); expect(t.locked).toBe(false) // untouched
    h.replaceTrackFlagsEverywhere('ghost', { locked: true }) // no such track → no-op, no throw
    expect(h.current().tracks.every((x) => !x.locked)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/history.test.ts` → FAIL (method missing).

- [ ] **Step 3: Implement.** Add the type (near the top exports) and the method (next to `replaceSettingsEverywhere`) in `history.ts`:

```ts
/** native/src/state/project.rs:151-162 TrackFlagsPatch — preference-shaped track
 *  toggles. null/absent = "don't touch". */
export interface TrackFlagsPatch { enabled?: boolean | null; muted?: boolean | null; solo?: boolean | null; locked?: boolean | null }
```
```ts
  /** native/src/state/history.rs:281-292 — patch one track's flags into EVERY
   *  snapshot + checkpoint where the track exists; skip snapshots that lack it;
   *  cursor unchanged; never recorded (project_settings_patch_convention). */
  replaceTrackFlagsEverywhere(trackId: Uuid, patch: TrackFlagsPatch): void {
    const patchTrack = (p: Project): Project => {
      const ti = p.tracks.findIndex((t) => t.id === trackId)
      if (ti < 0) return p
      const nt = { ...p.tracks[ti] }
      if (typeof patch.enabled === 'boolean') nt.enabled = patch.enabled
      if (typeof patch.muted === 'boolean') nt.muted = patch.muted
      if (typeof patch.solo === 'boolean') nt.solo = patch.solo
      if (typeof patch.locked === 'boolean') nt.locked = patch.locked
      return { ...p, tracks: p.tracks.map((t, i) => (i === ti ? nt : t)) }
    }
    for (const e of this.snapshots) e.snapshot = patchTrack(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = patchTrack(cp.snapshot)
  }
```

- [ ] **Step 4: Run to verify they pass** — same command → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/history.ts apps/desktop/src/main/state/history.test.ts
git commit -m "feat(state-migration): History.replaceTrackFlagsEverywhere (Phase 2b-ii)"
```

---

## Task 8: `update_track_flags` — dispatch (unrecorded) + vocabulary + driver + corpus

**Files:**
- Modify: `src/main/state/actor.ts`, `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`
- Test: `src/main/state/actor.test.ts`, corpus sequences

**Interfaces:**
- Consumes: `History.replaceTrackFlagsEverywhere`, `TrackFlagsPatch` from `./history`; `broadcastUnrecorded` (existing closure).
- Produces: dispatch handles `update_track_flags` (UNRECORDED: TrackNotFound check → replace-everywhere → broadcastUnrecorded); `SUPPORTED_OPS`/`buildArgs` gain it; driver gains its arm.

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts`:

```ts
describe('dispatch: update_track_flags (unrecorded)', () => {
  it('locks a track; later update_layer on it is TrackLocked', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 't'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    expect(actor.dispatch('update_track_flags', { track: a, patch: { locked: true } }).ok).toBe(true)
    expect(actor.snapshot().tracks[0].locked).toBe(true)
    const r = actor.dispatch('update_layer', { layer: l, patch: { label: 'x' } })
    expect(r.ok).toBe(false); expect((r as { ok: false; error: { error: string } }).error.error).toBe('TrackLocked')
  })
  it('mute persists across undo (unrecorded)', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 't'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 })
    actor.dispatch('update_track_flags', { track: a, patch: { muted: true } })
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().tracks[0].muted).toBe(true) // unrecorded → survives undo
  })
  it('TrackNotFound for a missing track', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 't')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const r = actor.dispatch('update_track_flags', { track: '00000000-0000-0000-0000-000000000000', patch: { locked: true } })
    expect(r.ok).toBe(false); expect((r as { ok: false; error: { error: string } }).error.error).toBe('TrackNotFound')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported op).

- [ ] **Step 3: Wire `actor.ts`.** Extend the history import to include `TrackFlagsPatch`, add an `updateTrackFlags` closure (next to `moveTrack`), and a dispatch arm:

```ts
import { History, type Actor, type EntityRef, type TrackFlagsPatch } from './history'
```
```ts
  // ── update_track_flags (do_update_track_flags:3637-3650) — UNRECORDED.
  //    TrackNotFound first; then replace-everywhere + broadcast (burns one id,
  //    matching broadcast_unrecorded so the det counter stays aligned). ──
  function updateTrackFlags(id: Uuid, patch: TrackFlagsPatch): void {
    if (!current().tracks.some((t) => t.id === id)) throw new CommandFailure({ error: 'TrackNotFound', track: id })
    history.replaceTrackFlagsEverywhere(id, patch)
    broadcastUnrecorded('Updated track flags', current())
  }
```
Dispatch arm:
```ts
        case 'update_track_flags': updateTrackFlags(a.track as Uuid, a.patch as TrackFlagsPatch); return { ok: true, value: null }
```

- [ ] **Step 4: Wire `replay.ts`.** Add `'update_track_flags'` to `SUPPORTED_OPS`; add the `buildArgs` case:

```ts
    case 'update_track_flags': return { track: resolve(refs, cmd.track), patch: { enabled: cmd.enabled, muted: cmd.muted, solo: cmd.solo, locked: cmd.locked } }
```

- [ ] **Step 5: Add the driver arm** before the `other =>` arm in `replay_driver.rs` (extend the imports to include `TrackFlagsPatch` — re-exported at `weftcut_lib::state`):

```rust
        "update_track_flags" => {
            let patch = weftcut_lib::state::TrackFlagsPatch {
                enabled: cmd["enabled"].as_bool(),
                muted: cmd["muted"].as_bool(),
                solo: cmd["solo"].as_bool(),
                locked: cmd["locked"].as_bool(),
            };
            h.update_track_flags(u, resolve_id(refs, cmd["track"].as_str().unwrap()), patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
```

- [ ] **Step 6: Author the corpus sequences:**

`update-track-flags-lock.json` (gates `TrackLocked` via the real track-lock setter)
```json
{ "name": "update-track-flags-lock", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "update_track_flags", "track": "@A", "locked": true },
  { "op": "update_layer", "layer": "@L1", "label": "x" }
] }
```
`update-track-flags-mute.json`
```json
{ "name": "update-track-flags-mute", "commands": [
  { "op": "update_track_flags", "track": "@A", "muted": true }
] }
```
`update-track-flags-unrecorded-undo.json`
```json
{ "name": "update-track-flags-unrecorded-undo", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "update_track_flags", "track": "@A", "muted": true },
  { "op": "undo" }
] }
```
`update-track-flags-not-found.json` (real-but-absent track id)
```json
{ "name": "update-track-flags-not-found", "commands": [
  { "op": "add_track", "label": "extra", "ref": "T1" },
  { "op": "delete_track", "track": "@T1" },
  { "op": "update_track_flags", "track": "@T1", "locked": true }
] }
```
`group-fanout-track-locked-reject.json` (gates `TrackLocked` inside group fan-out across tracks)
```json
{ "name": "group-fanout-track-locked-reject", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 2000000, "t_end_us": 3000000, "ref": "L2" },
  { "op": "groups_create", "layers": ["@L1", "@L2"], "ref": "G1" },
  { "op": "update_track_flags", "track": "@B", "locked": true },
  { "op": "move_layer", "layer": "@L1", "to_track": "@A", "t_start_us": 5000000, "escape_group": false }
] }
```

- [ ] **Step 7: Regenerate oracles + run the gate.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the 5 new oracle files as ??
npx vitest run src/main/state/actor.test.ts src/main/state/__tests__/differential.phase2.test.ts
```
Expected: gate PASS at 94 sequences (89 + 5), `skipped === []`.

> The `group-fanout-track-locked-reject` oracle records whatever Rust actually does at the final step. Group fan-out's `checkGroupLock` reports `TrackLocked` when a touched sibling is on a locked track; if Rust's debug variant differs (e.g. it surfaces `GroupLockedMember` instead), the regenerated oracle is the truth — match the TS to it; investigate only if the TS diverges from the regenerated oracle.

- [ ] **Step 8: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/update-track-flags-lock.json apps/desktop/fixtures/state-corpus/sequences/update-track-flags-mute.json apps/desktop/fixtures/state-corpus/sequences/update-track-flags-unrecorded-undo.json apps/desktop/fixtures/state-corpus/sequences/update-track-flags-not-found.json apps/desktop/fixtures/state-corpus/sequences/group-fanout-track-locked-reject.json apps/desktop/fixtures/state-corpus/oracle/update-track-flags-lock.json apps/desktop/fixtures/state-corpus/oracle/update-track-flags-mute.json apps/desktop/fixtures/state-corpus/oracle/update-track-flags-unrecorded-undo.json apps/desktop/fixtures/state-corpus/oracle/update-track-flags-not-found.json apps/desktop/fixtures/state-corpus/oracle/group-fanout-track-locked-reject.json
git commit -m "test(state-migration): update_track_flags live + corpus (Phase 2b-ii)"
```

---

## Task 9: Full suite green + README + whole-branch review + finish

- [ ] **Step 1: Full state suite + typecheck.**
`npx vitest run src/main/state` → all green (capture the count). `npm run typecheck` → clean. Confirm the differential gate reports the final corpus count (~94) with `skipped === []`.

- [ ] **Step 2: Update the corpus README** (`fixtures/state-corpus/README.md`). Move closed gaps into the coverage table:
  - #1 `groups_dissolve (explicit)` → DONE (`groups-dissolve-explicit.json`).
  - #2 `Move to custom track` → DONE (`move-track-to-custom-target.json`).
  - #3 `Lock-member rejection` → DONE — layer-lock (`group-locked-member-reject.json`) AND track-lock (`update-track-flags-lock.json`, `group-fanout-track-locked-reject.json`).
  - #4 `Group add/remove members` → DONE (`groups-add-members.json`, `groups-remove-members-*.json`).
  Add coverage rows for markers (`update-marker-*`, `remove-marker`, `marker-remove-then-update-notfound`), tracks (`delete-track-*`, `move-track-*`), rename (`groups-rename`, `groups-rename-clear`), and track flags (`update-track-flags-*`, `group-fanout-track-locked-reject`). Leave still-open gaps: #5 media-bearing layers, #6 history cap >200, #7 `set_composition` fps/canvas, #8 duplicate negative offset, #9 caption tracks / effects / transitions / params; plus note **marker `color` patches are unit-tested but not differential-gated this slice** (driver doesn't parse a color object).

- [ ] **Step 3: Commit the README.**
```bash
git add apps/desktop/fixtures/state-corpus/README.md
git commit -m "docs(state-migration): corpus README — close gaps 1-4 + Phase 2b-ii coverage"
```

- [ ] **Step 4: Whole-branch code review** (superpowers:requesting-code-review). Scope: the Phase-2b-ii commits. Focus: (a) the driver ref-capture generalization is purely additive (69 pre-existing oracles byte-identical); (b) `move_track`'s no-op skips `commit` (no op_id burned — verified by `move-track-noop` yielding identical entity ids); (c) `update_track_flags` is unrecorded, TrackNotFound-first, and `broadcastUnrecorded` burns exactly one id (counter alignment); (d) `update_marker` re-sorts only on `t_us` change and `end_t_us` is set-only; (e) `delete_track` rejection order matches Rust; (f) gate integrity preserved (`skipped === []`, every new oracle byte-identical via regen).

- [ ] **Step 5:** superpowers:finishing-a-development-branch — confirm the integration choice (this work sits on local `main`; per Phase 0/1/2a/2b-i, default keep-local/unpushed unless the user says otherwise).

---

## Self-Review (author checklist — completed)

- **Spec coverage:** ref-capture generalization (Task 1); group-membership family — dissolve/add/remove/rename + GroupLockedMember (Task 2); markers update/remove (Tasks 3-4); custom tracks delete/move incl. the no-op landmine + move-to-custom-target (Tasks 5-6); `update_track_flags` unrecorded track-lock + cross-track fan-out TrackLocked (Tasks 7-8). Closes README gaps #1-#4. ✓
- **Placeholder scan:** every step has concrete code/commands/expected output. ✓
- **Type consistency:** `MarkerPatch`/`applyUpdateMarker`/`applyRemoveMarker` (markers.ts), `applyDeleteTrack`/`applyMoveTrack` (tracks.ts), `TrackFlagsPatch`/`replaceTrackFlagsEverywhere` (history.ts) named identically across producing + consuming tasks; error variants pre-exist in `errors.ts`; dispatch arg shapes (`marker`/`group`/`track`/`patch`/`force`/`new_position`/`layers`) consistent between `buildArgs`, the dispatch arms, and the driver. ✓
- **Landmines captured:** additive-driver-change (existing oracles byte-identical), gate-ordering invariant, `move_track` no-op skips commit (id-drift), `update_track_flags` unrecorded + broadcast-burns-one-id, `MarkerPatch.end_t_us` set-only, `update_marker` stable re-sort on t_us only, `delete_track` rejection order + grouped-member validation hazard, real-but-absent-id technique for *-NotFound corpus sequences (resolve_id parses uuids). ✓
- **Ungated-by-corpus paths covered by unit tests:** marker `color` patch (markers.test.ts); `TrackPositionOutOfRange`/`TrackNotFound`/`TrackNotRemovable`/`TrackNotEmpty` also have direct unit tests (tracks.test.ts) in addition to corpus coverage. ✓

## Phase-2b-iii+ carry-forwards (NOT this plan)

- 2b-iii: effects (`add_effect`/`remove_effect`/`update_effect`/`reorder_effect` — needs effect-id ref-capture, now generalized).
- 2b-iv: transitions (`add_transition`/`remove_transition`) + `set_composition`-full (fps re-snap — the existing `actor.ts setComposition` fps path to gate/complete; README gap #7).
- 2b-v: media-bearing layers + media pool ops (`add_media`/`remove_media`, unrecorded) + `separate_audio` + params (`update_layer_params`/`update_layer_param_track(s)`/`rebind_motif`).
- 2b-vi: captions (`add_caption_track`) + `set_role_gain` (recorded) / `update_role_flags` (unrecorded) / `update_project_settings`.
