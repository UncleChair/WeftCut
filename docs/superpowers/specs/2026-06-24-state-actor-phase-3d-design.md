# State-actor TS migration — Phase 3d design (MCP category-A port)

Date: 2026-06-24. Status: brainstormed + approved; 3d-a detailed, 3d-b/c/d sketched.
Predecessor: Phase 3c-ii-d (THE FLIP) — the TS state actor is authoritative for the
renderer + main path behind `WEFTCUT_TS_ACTOR` (default OFF; Rust actor = fallback
until Phase 4). 3c-ii-d shipped with **MCP category-A mutations PAUSED** under the flag
(`mcp/mutationTools.ts` `isPausedUnderTsActor`; `server.ts` throws -32600). Phase 3d
lifts that pause by porting the MCP category-A tool surface onto the TS actor.

## Goal

Make the MCP tool surface work against the TS state actor so that, under
`WEFTCUT_TS_ACTOR`, external agents can mutate and read project state through MCP
exactly as they do today against the Rust actor — byte-identical results and errors —
and the mutation pause can be removed.

## Topology recap (verified vs code)

- The MCP host is already TypeScript: `src/main/mcp/{server,mutationTools,auth,index}.ts`.
- `server.ts` `CallTool` → `backend.mcpCallTool(name, argsJson)` → Rust
  `dispatch_tool` (`native/src/mcp/catalog.rs:23-36`), a `match name { … }` generated
  by the `tool_table!` macro (`catalog.rs:10-38`, entries `40-276`).
- Handlers live in `native/src/mcp/tools.rs`; each is
  `async fn(b:&Backend, args)->Result<ToolResult,McpToolError>` and reaches state via
  `b.project()?.<method>(agent_actor(), …)` (some via `crate::commands::mutations::*`,
  the Step-1a shared command layer — e.g. `move_layer` at `tools.rs:622-625`).
- Wire envelope (`native/src/mcp/wire.rs`): the napi method returns
  `reply(...)` = `{ok:true,result:<ToolResult>}` or `{ok:false,error:<McpToolError>}`
  (`wire.rs:180-185`). `ToolResult` = `{content:[ContentBlock], isError?}` where
  `isError` is omitted when false (`wire.rs:70-93`); `ContentBlock::Text` →
  `{type:"text",text}` (`wire.rs:59-68`). `McpToolError` =
  `{code,message,data?}` with `code` snake_case (`invalid_params|invalid_request|
  not_found|internal`, `wire.rs:8-23`). `server.ts` `unwrap()` maps those codes to
  JSON-RPC numbers (`CODE_MAP`: -32602/-32600/-32601/-32603) and the SDK turns a
  thrown error into the response — so the TS adapter must reproduce the **same
  envelope JSON** and `server.ts` stays unchanged.

## Decisions (this brainstorm)

- **D1 — Slicing.** Phase 3d is sliced into four sub-slices, each its own
  spec/plan → SDD (like 3c-ii): **3d-a** adapter foundation + mechanical tools +
  `map_command_error`; **3d-b** keyframes (8 tools) + `dry_run`; **3d-c** checkpoints
  + agent session; **3d-d** hybrids + read re-pointing + the live routing flip +
  un-pause. `add_motif` + `project_restore_checkpoint` are deferred to Phase 4
  (motif-catalog-in-TS blocked / no checkpoint-create precondition).
- **D2 — Gating.** Det-id **MCP-channel differential**: a new `mcp_driver` drives the
  REAL Rust `dispatch_tool` under deterministic ids; a new corpus dimension
  `sequences-mcp/` + `oracle-mcp/` captures per-step ToolResult-or-error JSON **and**
  canonical state; a TS `mcp.differential.test.ts` replays each sequence through the
  TS adapter and asserts byte-identity. Matches the migration keystone ("prove
  equivalence mechanically") and the 3c-ii-a D1 production-differential precedent.
- **D3 — Live wiring timing.** 3d-a–c build the adapter + gate **fully but DORMANT**:
  no `server.ts`/router change, `MUTATION_TOOLS` pause unchanged. The single live
  routing flip + full un-pause is **3d-d** (build dormant, flip atomically — the
  3c-ii pattern). MCP stays paused under the flag during the renderer-path soak.

## What already exists (so 3d is adapter + gating, not new mutations)

- The TS actor `dispatch()` (`src/main/state/actor.ts:324-`) already covers nearly
  every underlying mutation (tracks, layers, groups, effects, composition, markers,
  caption tracks, media, role gain/flags), all differential-gated.
- `actor.command(channel, wireArgs)` (`actor.ts:51`) is the production adapter
  (3c-ii-a); `commands.ts` holds `MECHANICAL`/`PRODUCTION_OPS`/prod param builders.
- `History` has full checkpoint infra (`history.ts` `checkpoint`/`restoreCheckpoint`/
  `listCheckpoints`) — used by 3d-c. `lockHistory`/`unlockHistory`/`dryRun` are
  already on `ActorHandle` (`actor.ts:56-58`).
- Keyframe edit algorithms already exist in TS (`renderer/keyframe/edits.ts`,
  golden-tested vs Rust `state/keyframe_edits.rs`) — used by 3d-b.

---

# Phase 3d-a — adapter foundation + mechanical tools + error map (DORMANT)

## Scope: the ~31 mechanical category-A tools

State effect maps onto already-gated actor commands. Built dormant; live flip = 3d-d.

| Group | Tools |
|---|---|
| Tracks | `add_track`, `remove_track`, `move_track` |
| Layers | `add_color_layer`, `add_video_layer`, `update_layer`, `update_layer_params`, `move_layer`, `split_layer`, `delete_layer`, `trim_layer`, `duplicate_layer` |
| Groups | `groups_create`, `groups_dissolve`, `groups_add_members`, `groups_remove_members`, `groups_rename` |
| Effects | `add_effect`, `update_effect`, `move_effect`, `remove_effect` |
| Composition | `set_composition`, `fit_composition_to_layers` |
| Markers | `add_marker`, `update_marker`, `remove_marker` |
| Media | `remove_media` |
| History | `undo`, `redo`, `lock_history`, `unlock_history` |
| Roles | `set_role_gain`, `set_role_flags` |

`lock_history`/`unlock_history` are in 3d-a (already on `ActorHandle`; trivial), though
they pair semantically with agent-session (3d-c) — movable if desired.

Out of 3d-a (later slices): keyframes + `dry_run` (3d-b); `checkpoint`/
`restore_checkpoint`/`list_checkpoints`/`begin_agent_session` (3d-c);
`apply_subtitles`/`import_media`/`synthesize_speech`/`project://` resources +
read tools + un-pause (3d-d); `add_motif`/`project_restore_checkpoint` (Phase 4).

## Architecture — two new artifacts, both dormant

1. **TS adapter** — new `src/main/state/mcp-commands.ts`, a pure
   `mcpCallTool(actor, name, argsJson) → envelopeJson` (no Electron/IPC imports):
   - parse MCP args (third vocab: `track_id`/`layer_id`/`media_id`, snake_case,
     `parse_uuid`-style UUID validation → `invalid_params` on bad input);
   - call the gated actor core — reuse `actor.command()`/`dispatch()` closures where
     the op matches; MCP-specific logic only where it diverges (notably
     `add_video_layer` auto-pair, see fidelity risks);
   - shape the exact `ToolResult` per tool;
   - wrap in the `{ok,result|error}` envelope (a TS `reply`/`unwrap`-mirror).
   - `agent_actor()` = `Actor::Agent{client:"mcp"}` (`tools.rs:46-50`).
   - **No `server.ts`/router edits in 3d-a.**
2. **Rust `mcp_driver`** — new `native/src/bin/mcp_driver.rs`, a clone of
   `native/src/bin/prod_driver.rs` that drives `dispatch_tool` (not `Backend::dispatch`)
   under det mode and emits per-step `{tool, ok, error, result, state}`. Requires a
   `feature="replay"`-gated `pub` re-export of `dispatch_tool` in `lib.rs` (mirrors
   3a's `build_project_summary` pub-bump + `pub use`). Reuses `Backend::new_for_replay`
   / `init_for_replay` (3c-ii-a) + `NullEventSink`.

## The byte-identical contract

- **Success envelope:** `{ok:true, result:{content:[…]}}`:
  - id tools → `[{type:"text",text:"<raw uuid>"}]` (`ToolResult::text(id.to_string())`,
    note: raw UUID, NOT JSON-encoded — differs from `dispatch()` which `ser()`s the id);
  - void tools (`remove_track`/`move_track`/`update_layer`/`update_layer_params`/
    `move_layer`/`delete_layer`/`trim_layer`/`update_marker`/`remove_marker`/
    `remove_media`/`undo`/`redo`/`lock_history`/`unlock_history`/`set_role_gain`/
    `set_role_flags`/`set_composition`/`fit_composition_to_layers`/`groups_*` except
    create) → `{content:[]}` (`ToolResult::empty()`);
  - structured tools → `[{type:"text",text:"<serialized JSON>"}]`: `add_video_layer`
    pair `{video_layer_id,audio_layer_id,group_id}`, `split_layer` `{left,right}`.
  - (Per-tool exact returns are pinned by the gate; the SDD tasks read each handler.)
- **Error envelope:** `{ok:false, error:{code,message,data?}}` — requires porting
  **`map_command_error`** (`tools.rs:61-118`) to TS:
  - `InvalidArgument{field,detail}` → `invalid_params("{field}: {detail}")`;
  - `Backend(msg)` → `internal(msg)`;
  - `ValidationFailed(LayerOverlap{…})` → `invalid_params(message, data)` where
    `data = {error:"LayerOverlap", track, blocking_layer, blocking_range_us:[a_start,
    a_end], requested_range_us:[b_start,b_end], options:[{action:"create_new_track",
    kind:"Video"},{action:"trim_existing",layer_id,new_t_end_us:b_start},
    {action:"split_at_t",layer_id,at_t_us:b_start}]}`;
  - `MediaInUse{media,referenced_by}` → `invalid_params(message, data)` where
    `data = {error:"MediaInUse", media, referenced_by, options:[{action:"force_remove",
    note:"…"},{action:"delete_layers_first",layer_ids}]}`;
  - else → `invalid_params(message)` where `message` = the `CommandError` Display
    string.
- **Error-gating refinement (decided at plan time, 2026-06-24):** the differential
  gate asserts the MCP error `code` + structured `data` (the agent-actionable
  recovery options) byte-identically **+ the error variant**, but treats the prose
  `message` as non-asserted (the TS adapter generates a reasonable message;
  `InvalidArgument`'s `"{field}: {detail}"` is reproduced exactly since it is
  structured, not prose). This matches the existing prod gate's variant-only error
  comparison and avoids porting Rust's ~30 `CommandError`/`ValidationError` Display
  strings into a TS twin (which Phase 4 would only delete). Supersedes the literal
  "message byte-identical" wording above.

## Differential gate (det-id MCP differential)

- New corpus dimension under `fixtures/state-corpus/`: `sequences-mcp/` (MCP
  tool-name + args; `@ref` tokens resolved like prod_driver) + `oracle-mcp/`
  (per step: ToolResult-or-error JSON **and** canonical state, so the gate proves
  envelope + state effect together).
- `mcp_driver` regenerates oracles under det mode with the verified toolchain env:
  `FFMPEG_DIR=<…Gyan.FFmpeg.Shared…/ffmpeg-8.1.1-full_build-shared>`,
  `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH+=$FFMPEG_DIR/bin`, build
  `--features replay,jobs,export,mcp,cloud,motifs`. **Additive**: existing 175 state +
  174 summary + 35 prod + persistence oracles stay byte-identical
  (`git diff --diff-filter=M fixtures/state-corpus` = ∅).
- New gate `src/main/state/__tests__/mcp.differential.test.ts`: replays each MCP
  sequence through TS `mcpCallTool`, asserts per-step envelope-JSON + canonical-state
  equal, `skipped===[]`. Mirrors `commands.differential.test.ts`.

## Fidelity risks the gate must pin

- **`add_video_layer` auto-pair** uses `ensure_audio_track` (topmost track or a new
  "Voiceover" track, `tools.rs:123-130`) — this **differs** from the renderer
  `add_media_layer` auto-pair (same-track Dialogue role, 3c-ii-d). The TS adapter's
  `add_video_layer` needs its own MCP-specific auto-pair path, not a reuse of the
  renderer command. Highest-risk mechanical tool.
- **`set_composition`** full semantics (atomic combined-probe validate, fps re-snap,
  canvas-everywhere unrecorded vs duration-recorded) — already ported on the actor
  (2b-iv); the MCP arg shape feeds the same path. Verify arg mapping.
- **`CommandError` Display message strings** must match Rust `thiserror` output exactly.
- **`remove_media` force-cascade** (raw splice removal, no empty-track prune /
  group cleanup — 3c-i) and the `MediaInUse` error data.
- **id allocation order** under det mode must match (op/entity/broadcast ids share
  one counter) — the same contract proven across prior slices.

## Gates / definition of done

`mcp.differential` (new) green + existing `differential.phase2`/`summary.differential`/
`persistence.differential`/`commands.differential` still green (all `skipped===[]`);
full vitest suite; `tsc -b` clean; Rust lib tests pass; corpus additivity proven;
final opus whole-branch review READY-TO-MERGE with zero Critical/Important. **No
`server.ts`/`mutationTools.ts` change** (dormant) — verified by diff.

## SDD plan shape (preview — finalized by writing-plans)

~5 tasks: (T1) `mcp_driver` spike + `replay`-gated `dispatch_tool` re-export + one
sequence end-to-end, de-risking the harness; (T2) TS `mcp-commands.ts` scaffold +
`map_command_error` port + envelope helpers + the `mcp.differential` gate; (T3)
layer-creation family incl. `add_video_layer` MCP auto-pair; (T4) mechanical batch
(tracks/groups/effects/markers/composition/roles/history/`remove_media`); (T5) audit +
corpus-README update + typecheck/full-suite verification.

---

# 3d-b / 3d-c / 3d-d (sketch — each gets its own spec/plan)

- **3d-b — keyframes + dry_run.** Wire `renderer/keyframe/edits.ts` reachable from
  main (crosses the project boundary like `summary.ts`'s view types — same Phase-4
  unification debt) + timeline-absolute↔layer-local time conversion; the 8 keyframe
  tools (`set_keyframe`/`remove_keyframe`/`retime_keyframe`/`set_keyframe_easing`/
  `smooth_keyframes`/`clear_keyframes`/`set_param_track` + read `get_param_track`)
  compute a new `AnimTrack` then call `update_layer_param_track`. Port `dry_run`
  spec→`DryRunOp` parsing onto the existing `actor.dryRun`. Differential-gated.
- **3d-c — checkpoints + agent session.** Expose `checkpoint`/`restoreCheckpoint`/
  `listCheckpoints` as actor commands (History infra exists); port
  `begin_agent_session` (auto-checkpoint + UI flip + `lockHistory`) and the
  `agent_session_end` history-unlock seam. Differential-gated where state-bearing.
- **3d-d — hybrids + reads + the flip.** `apply_subtitles` (Rust parse → TS caption
  track, already ported), `import_media`/`synthesize_speech` state-writes (Rust
  compute → TS write); **re-point `project://` resources + read tools to the TS actor**
  (mandatory — under the flag the Rust actor is stale; final-review O1). The read
  re-point set is: resources `project://current|composition|media|tracks|markers|
  compiled|layers/{id}` (`resources.rs:66,93,147`) + tools `groups_list`/`groups_get`
  (`tools.rs:776,794`), `get_param_track` (`tools.rs:923`), `dry_run` (`tools.rs:1671`),
  **`detect_silences` (`tools.rs:494`)** and **`transcribe_clip` (`tools.rs:2631`)** —
  the last two read `b.project()?.snapshot()` to resolve a layer's source window (F8
  below). Then the single live `server.ts` routing flip + `MUTATION_TOOLS` un-pause.

# Post-flip audit (2026-06-24): native-compute stale-actor gap + Phase 3d-e

A correctness audit (prompted by the question "after 3d, does any Rust fallback still
read/write the stale Rust actor?") found a **whole class of renderer-side
`backend.invoke` channels that the 3c-ii-d plan listed as "stays on Rust, unchanged"
(plan §"Findings recap", line 40) and rationalized as "independent of the migrated
Project" (line 42) — but which actually READ or WRITE the project actor.** Under the
flag the Rust actor is frozen at blank init (mutations only reach `tsHost`;
`index.ts:316` falls through to `backend.invoke`), so these operate on blank/stale
state. This violates the 3c-ii-d plan's own single-writer invariant (line 14) and is
**NOT covered by 3d** (MCP-only). Deferring to Phase 4 is unsafe: the flag can go
default-on after the 3d soak (D7) — before Phase 4 deletes Rust state.

**Principle:** Rust may keep native compute, but its project/media INPUT must come from
the TS actor snapshot or explicit args — never `backend.project()`.

**Findings (severity-ranked; file:line):**

- 🔴 **F1 `export_project_audio_only`** `commands/export.rs:34-36` — clones the whole
  stale project and exports its audio → silent wrong/empty audio in every export.
- 🔴 **F2 `ensure_export_audio_conform`** `commands/export.rs:107-113` — export-readiness
  gate computed from stale audio layers.
- 🔴 **F3 `import_media` (renderer)** `commands/media.rs:25,88` — `add_media_item` writes
  the stale Rust pool; media never reaches TS → split-brain, `add_media_layer` fails
  `MissingMedia`. (3d-d covers only the *MCP* `import_media`.)
- 🟠 **F4 `ensure_full_proxy`** `commands/media.rs:167-168,176` — reads stale AND writes
  `set_media_derivatives` **directly**, bypassing the 3c-ii-c `commit_media_derivatives`
  event seam (cached-proxy fast path → TS never learns the proxy path).
- 🟠 **F5 `ensure_conform`** `commands/media.rs:189-190` — resolves the media item from
  stale state.
- 🟠 **F6 `get_media_thumbnail` / `get_waveform_peaks`** `commands/media.rs:142-143,154-155`
  — resolve media paths from the stale pool.
- 🟠 **F7 `motif_staleness_report` (read) / `acknowledge_motif_staleness` (write
  `rebind_motif`)** `napi_backend.rs:812,814` — route to `rust`, read/write the actor for
  motif-bearing projects.
- 🟠 **F8 MCP `project://` resources + read tools** — stale reads served to agents;
  **already in plan (3d-d)**, but must enumerate `detect_silences`/`transcribe_clip`
  (done above).
- 🟡 **F9 jobs `fresh_media_item`** `jobs/mod.rs` — stale freshness source; Phase-4
  cleanup (already documented), acceptable once F3/F4 land.

**Not at risk:** MCP `import_media`/`synthesize_speech` (paused via `MUTATION_TOOLS`);
`add_motif`/`project_restore_checkpoint` (`BLOCKED_UNDER_FLAG`); pure prefs/persistence/
motif-store/video-sink/`mux_export` (no actor access).

## Phase 3d-e — native-compute input re-point (NEW; gates flag-default-on)

A new slice (independent of 3d-a..d) that MUST land before `WEFTCUT_TS_ACTOR` goes
default-on. For F1–F7: Rust keeps the ffmpeg/audio/export compute, but its project/media
input comes from the TS actor — preferred shape = **explicit args** (e.g.
`export_project_audio_only` already takes `output_path`/`audio`/window; extend it to take
the serialized project / compiled-audio plan from the TS actor), or a `Backend` napi
read-mirror setter the TS host pushes the current serialized project into before each
compute call. `import_media` becomes a hybrid: Rust ffprobe/blake3 → returns the
`MediaItem` → TS `add_media_item`. `motif_staleness_*`: re-point or `reject` under the
flag like `add_motif`.

**Gates for 3d-e (and a durable guard):**
1. **Architectural gate (high value):** a test enumerating every channel routed to
   `{kind:'rust'}` (`router.ts`) and asserting each is on a vetted `PURE_NATIVE`/
   `PERSISTENCE` allowlist — fails CI if any project-actor-touching channel routes to
   Rust. Would have caught F1–F7 mechanically; prevents regression. (Cross-check via
   `rg "backend.project()"` against the rust-route set, or handler tags.)
2. **Flag-on e2e:** (a) import media → assert it appears in TS `project_summary`;
   (b) export audio under the flag → assert the rendered audio matches the TS project
   (catches F1/F2 silent-wrong-output).
3. **3d-e build is differential/unit-gated** like prior slices where state-bearing.

**Impact on other plans (recorded):** master plan §1.3 / Phase 4 — the kept
media/export/jobs compute arms need their INPUT re-pointed (they can't read
`backend.project()` once `state/` is deleted), and the flag must not go default-on
before 3d-e; 3c-ii design spec D7 — flag-on-after-soak gains a 3d-e prerequisite;
3c-ii-d plan lines 40/42 — corrected (the "unchanged Rust" list mis-classified
actor-touching channels). The merged phase-0..3c-ii-c plans and the non-migration
plans (effects-ui, keyframe-opt, pipeline-seam, subtitle) are NOT affected (historical;
their `backend.project()` refs were valid when Rust was authoritative).

## Constraints (carried)

- wasm eval leaf is sacred; keep `snap.ts`/`renderer/eval` pure (engine-source-drift,
  snap-math-drift goldens).
- `TimeUs = number` is safe; preference patches stay unrecorded.
- Evergreen docs: this spec/plan is a dated snapshot; design docs in `docs/` stay
  date/phase-free.
- Rides the command-surface unification (`commands/mutations.rs` Step-1a) — re-points
  that one impl at the TS actor.
