# State-Actor TS Migration — Phase 4 Design (Decommission the Rust state actor)

**Date:** 2026-06-25
**Status:** Design — approved decisions captured; pending spec review before writing-plans.
**Branch base:** local `main` HEAD `d2d6f3a1` (NOT pushed). Working tree clean except the two
untracked `code-review-20260625-*` reports.
**Predecessors:** Phases 0–3d-e merged to local `main`; the Phase 1–3 independent review and the
manual flag-on soak (D7) both passed (see `project_state_actor_ts_migration` memory + the master
plan `plans/2026-06-22-state-actor-ts-migration.md` §Phase 4).

> Line/symbol anchors below were gathered by read-only audit of HEAD `d2d6f3a1`. Exact line
> numbers are verified again at planning time; the *structure* they point at is what binds.

---

## 0. Where we are

The TS state actor (`apps/desktop/src/main/state/`) is authoritative for the renderer **and** the
MCP surface behind one launch flag `WEFTCUT_TS_ACTOR` (default **OFF**; the Rust actor is the
fallback). Phase 3d-d introduced a **read-mirror** — Rust serves project *reads* from a TS-pushed,
deserialized `Arc<Project>` (`napi_backend.rs` `read_mirror` / `set_project_mirror` /
`snapshot_for_read`). Phase 3d-e re-pointed the native-compute *inputs* (export/import/proxy/
conform/thumbnail/waveform, motif staleness) to that mirror and made the 5 write-paths hybrids
("native-compute → TS-write"). The D7 manual soak at `WEFTCUT_TS_ACTOR=1` passed; the only finding
(malformed MCP args poisoning the actor) was fixed in `d2d6f3a1`.

**Still owed before the migration is closed:**
- 4 ports still `BLOCKED_UNDER_FLAG` or deferred: `project_restore_checkpoint`, `add_motif`, the
  Motif `update_layer_params` content-window clamp, and the `fresh_media_item` stale read.
- The recurring malformed-input class (the Phase 1–3 review's through-line): unchecked
  `as`-casts in inline command/MCP arms — only partially closed by `d2d6f3a1`.
- The irreversible decommission: delete the Rust state actor, its fallback dispatch arms, the dead
  autosave/jobs paths, the native MCP mutation handlers + catalog coupling, and retire the flag.

---

## 1. The forcing constraint: the differential harness dies with the actor

This migration's entire safety story is the **differential harness** — `replay_driver`,
`prod_driver`, `mcp_driver` (Cargo feature `replay`) drive the **real Rust actor / `Backend::
dispatch` / `dispatch_tool`** under deterministic ids, and `gen-state-oracle.mjs` writes the
committed oracle corpus (`apps/desktop/fixtures/state-corpus/`). The `*.differential.test.ts`
gates replay the corpus through the **TS** actor and assert byte-identity to those oracles.

The drivers depend on `state::spawn` / `ProjectHandle` / `Backend::{new,init}_for_replay`. **Deleting
the Rust actor makes the corpus un-regenerable.** The committed oracles survive as frozen TS-only
regression fixtures (the gates never needed Rust at *test* time — only the *drivers* did), but no
new TS≡Rust oracle can ever be minted again.

**Consequence (the spine of this plan): anything that should be byte-gated against Rust must land
and regenerate its oracles *before* the delete.** That forces two slices:

| Slice | Nature | Harness |
|---|---|---|
| **4a** | Additive ports + parser hardening | Differential-gated against the **live** Rust actor (last regen) |
| **transition** | Flip `WEFTCUT_TS_ACTOR` default-on + brief targeted soak | — |
| **4b** | Irreversible delete + MCP catalog split + flag removal + harness retirement | Frozen-oracle regression + e2e (no new oracles) |

Each slice gets its own spec → plan → SDD, as 3c/3d did.

---

## 2. Slice 4a — Port the stragglers + harden parsers

All gated against the live Rust actor; corpus grows additively; existing oracles stay byte-identical.

### 2.1 `project_restore_checkpoint` (smallest)
The TS path already exists end-to-end: `history.ts`/`actor.ts` `restoreCheckpoint` + the
`restore_checkpoint` dispatch arm, plus 3d-c's `begin→restore` differential corpus. It is blocked
only because no renderer channel *creates* a checkpoint, so the restore precondition was
unreachable during the single-writer soak.

**Work:**
- Wire the **renderer channel** `project_restore_checkpoint` onto the production command surface
  (`commands.ts` MECHANICAL table + `PRODUCTION_OPS`) and drop it from `router.ts`
  `BLOCKED_UNDER_FLAG` and the MCP `MCP_BLOCKED_UNDER_FLAG`.
- **Log side-effect (your correction):** Rust restore emits a Project log entry
  (`commands/history.rs` `backend.log_slot.emit(...)`); the TS `actor.ts` `restoreCheckpoint`
  restores state/history only. This is the broader 3d-d LogBus-under-flip gap — under default-off
  it was accepted; at default-on the record panel silently loses checkpoint-restore (and
  `begin_agent_session`/`checkpoint`/`lock_history`/`unlock_history`) authorship. 4a adds the outer
  **log emit on the TS host restore path** and restores parity for the sibling history/checkpoint
  ops served by TS (scoped sub-item; logs are not state and not differential-gated, so this is
  verified by inspection + e2e, not the corpus).
- **Gating wrinkle to resolve in planning (not blocking):** the renderer-restore prod-differential
  seq needs a checkpoint to pre-exist; there is no renderer *create-checkpoint* channel. Options:
  seed via a debug/agent-session create in the prod corpus, or accept that restore is
  corpus-gated via the existing MCP `begin→restore` seqs and the renderer channel is a thin
  alias verified by unit test + the targeted soak. Decide in the plan.

### 2.2 `add_motif` — hybrid (Rust validates, TS applies)
`add_motif` joins the 3d-e hybrid family. **No new cross-language validation twin** — the strict
`canonicalize_props` (`motifs/catalog.rs`), catalog lookup (built-ins via `include_str!` +
`UserMotifStore`), and motif version stay Rust's single source.

**Rust compute payload (the tightened contract — your correction):** the compute entrypoint reads
the read-mirror and returns
- canonical, validated `props` (after strict `canonicalize_props`),
- `motif_version`,
- resolved `t_end_us` (after the manifest-cap clamp, `resolve_motif_t_end_us`),
- **a track *plan*, NOT a resolved track id** — i.e. "use existing track `<id>`" *or* "create an
  Overlay track" (the resolution that `resolve_overlay_track` does today). Returning a *minted* id
  here would steal id-allocation from the TS actor and break the deterministic id contract.

**TS apply:** the host applies the mutation through the gated actor and **mints all ids itself**,
preserving the **no-`track_id` → two-commit form** (create Overlay track, then add the Motif layer —
ids in that order, matching `add_color_layer`'s overlay path proven in 3c-ii-a). The Motif layer is
`LayerParams::Motif { motif_id, motif_version, props, src_in_us:0, transform, opacity }`.

**Gated like the other hybrids:** the Rust driver runs the real `add_motif` (compute + Rust-actor
apply) for the oracle; the corpus captures the Rust-resolved payload; the TS replay applies that
payload through the TS actor and must reach byte-identical state. The compute half (canonicalize/
cap) is Rust-only, so there is nothing to twin or gate on it. **Renderer vs MCP differ and are
gated separately:** the **actor source** (`User` for the renderer channel vs the MCP agent actor)
and the **MCP `ToolResult` shape** each get their own coverage.

### 2.3 Motif `update_layer_params` content-window clamp
Today `params.ts` (the Motif arm) only field-merges — the clamp (`state/actor/mutations.rs`
≈ L372–453) is the **only** deferred mutation behavior, and after 4b there is no live Rust to gate a
later port against. So it lands now.

**Port (pure TS, inside the synchronous commit pipeline — cannot be a hybrid):**
- A **manifest cache** in the TS actor (`Map<motif_id, Manifest>`), hydrated from Rust `list_motifs`
  at bring-up and refreshed on motif install/delete. Manifests are *data single-sourced from Rust*
  (the `include_str!` built-ins + the store), not a logic twin.
- A **small `resolveMotifMaxDurUs(manifest, props)` cap helper**, **golden-gated** against Rust
  (`resolve_motif_max_dur_us`) using the `snap_frame_golden` precedent — a committed fixture of
  `(manifest, props) → cap_us` produced by Rust, asserted by TS. This is the only twin and it is
  bounded + golden-protected.
- The clamp itself (floor `src_in` into `[0, content_dur)`, recompute `t_end`, `max(t_start+1)`,
  via `snap.ts`) mirrors the Rust math exactly.

**Gating:** a built-in `countdown` corpus seq that shrinks `seconds` so the cap drops below the
current window, firing the clamp; the TS actor's manifest cache is seeded from the same built-in
manifest JSON Rust embeds.

### 2.4 `fresh_media_item` re-point (plumbing, not a one-liner — your correction)
`jobs/mod.rs` ≈ L773 `fresh_media_item(&ProjectHandle, …)` calls `.snapshot()` on the live actor;
under the flag this is stale (it currently falls back to the enqueue-time item — accepted). The fix
reads `Backend::snapshot_for_read()` (the mirror), but `snapshot_for_read` is a `Backend` method
while the job callers (`spawn_conform`/`spawn_proxy_*`/`spawn_waveform`) hold only a `ProjectHandle`.
So 4a **threads a `Backend` (or a narrow mirror accessor) into the job capture** and changes the
signature accordingly. Internal read; no differential coverage needed.

### 2.5 Parser-discipline hardening (folded in — your restatement)
**Goal, stated generally: every unknown→business-type adapter that runs *before* a commit must be
parser-gated.** `d2d6f3a1` closed only `add_marker`/`add_color_layer`/`add_video_layer`. Remaining
targets:
- `actor.ts` ≈ L368 (the command-channel arm casts),
- `specToDryRunOp` (dry-run op coercion),
- `mcp-commands.ts` ≈ L212 and the residual inline `mcpCall` arms still using `as number/string/Uuid`.

Reuse the typed validators (`parseRgba`/`parseNum`/`parseNumOpt`/`parseStr`/`parseUuid`/`parseRole`/
`parseInterp(Opt)`/`parseAnimatedF64`); malformed input rejects `-32602`/`InvalidArgument` **before**
commit, never `as`-casts to `NaN`/`undefined`. Regression tests assert *no commit* on malformed
input (the `mcp.malformed-args` pattern). **These parsers land directly in the §2.7 single-source
table's `parseArgs` (built this slice)** — written into their final home once, not into a structure
4b would rewrite.

### 2.6 Subscriber-starvation defense (folded in — your correction)
`actor.ts` ≈ L113 broadcasts via a synchronous `for (const cb of subs)` — one throwing subscriber
(e.g. `pushMirror` failing a Rust deserialize) aborts every later subscriber (autosave / mirror /
notify). Isolate each subscriber (try/catch per callback, warn-and-continue) so one bad subscriber
cannot starve the rest. Cross-refs: `feedback_ui_actor_bridge`, `feedback_async_block_on_in_async`.

### 2.7 Single-source MCP tool table + structural gate (dormant in 4a)
The TS-executed surface is keyed by tool name across **five** hand-maintained tables today
(`mcp-commands.ts` `MCP_ARG_PARSERS`/`MCP_RESULT_SHAPERS`/`MCP_TOOLS`; `mutationTools.ts`
`MCP_BLOCKED_UNDER_FLAG`/`HYBRID_TOOLS`). §4.2 would add a sixth — the TS `inputSchema`. Six parallel
name-keyed tables aligned by hand is exactly the drift surface the §6 "schema↔parser drift" risk
names; "single-sourced **alongside**" is a placement convention, not an invariant.

**Land the single table now (4a), dormant.** Define **one** record per TS-executed tool —
`{ name, description, inputSchema, parseArgs, shapeResult }` — and make `MCP_TOOLS`,
`MCP_ARG_PARSERS`, and `MCP_RESULT_SHAPERS` **projections** (`.map`/`.filter`) of it, not siblings.
The advertised `inputSchema` and the actual `parseArgs` then become **two fields of one record** —
they cannot drift by construction, which is what §4.2's "single-sourced" must mean to be real. Scope
is the ~46 `MCP_TOOLS` entries (mutations + the TS-served reads `get_param_track`/`list_checkpoints`);
`HYBRID_TOOLS` stays separate (their schema is Rust's, served by the hybrid compute half) — and
**`add_motif` (a hybrid per §2.2) joins `HYBRID_TOOLS`, NOT this table**, so its MCP schema stays in
the Rust `tool_table!`. The §2.5 parser-hardening writes straight into this table's `parseArgs`.

**Dormant until 4b.** In 4a `ListTools` still sources from Rust (`backend.mcpCatalog()`), so the
`inputSchema` field is defined-but-unadvertised. 4b's only behavioral change is flipping `ListTools`
to the merge + deleting the Rust mutation catalog (§4.2) — no second pass over the tool definitions.

**Structural gate (permanent, not differential — authored in 4a).** A pure unit test asserting the
catalog↔handler bijection:
1. `merge(Rust-native catalog, TS table)` is an **exact union** — no duplicate name, no dropped tool
   (covers the §6 "drops/duplicates a tool" risk);
2. every name in the merged catalog resolves to one execution path (`routeMcpTool` → `ts` for TS-table
   names, `rust`/`hybrid` for the native set) — no advertised-but-unhandled;
3. every `ts`-routed name is in the TS table (has `parseArgs` + `shapeResult`) and every `hybrid`-routed
   name is in `HYBRID_TOOLS` — no handled-but-unadvertised.

**Gate input across the flip.** The Rust catalog split is a 4b action, so in 4a there is no separate
"Rust-native catalog" yet — the gate derives it as the live `mcpCatalog()` **filtered to non-`ts`-routed
names** (merging the *full* live catalog, which still advertises the mutations, with the TS table would
fail point 1 on duplicates). With that derivation point 1 holds by construction and points 2–3 carry the
weight (clean routing partition + handler presence). In 4b the same gate re-targets the post-split merged
catalog: the bijection property is constant, only the "advertised set" input swaps. This backfills the
ListTools shape §4.2 notes was never corpus-gated, and unlike the differential gates it has no regen
dependency, so it survives 4b.

### 2.8 4a exit criteria
All differential gates green (`skipped===[]`), full vitest + Rust lib + `tsc -b` clean, corpus
**additive** (`git diff --diff-filter=M` over the oracle dirs empty), the flag-on e2es
(`ts-actor-flip`/`mcp-flip`/`ts-actor-native-compute`) green, `BLOCKED_UNDER_FLAG` /
`MCP_BLOCKED_UNDER_FLAG` reduced to ∅, the §2.7 single-source table built (dormant, with
`MCP_TOOLS`/`MCP_ARG_PARSERS`/`MCP_RESULT_SHAPERS` as projections) and its structural bijection gate
green. **This is the final oracle regeneration.**

---

## 3. Transition — flip default-on + brief targeted soak
After 4a is differential-green, flip `WEFTCUT_TS_ACTOR` to default-on and spend ~10 min exercising
**only the newly-reachable paths** live: add a motif via the UI; create then restore a checkpoint
(and confirm the record-panel log entry now appears); shrink a countdown's `seconds` to fire the
clamp. Clean → proceed to 4b. (The rest of the surface is differential-proven and was soaked at
`=1`; this gate is just the three never-soaked paths before an irreversible delete.)

---

## 4. Slice 4b — Decommission the Rust state actor (irreversible)

### 4.1 `ProjectHandle` consumer census (the deletion backbone)
Every site obtaining a `ProjectHandle` / calling `backend.project()` is classified:

**DELETE (mutate/read the live actor; dead under the flag):**
- `native/src/state/actor.rs` (the actor loop + `ProjectHandle` methods), the actor mutation
  helpers (`state/actor/mutations.rs`), `state/history.rs`, `state/validate.rs`.
- `native/src/commands/mutations.rs` and `commands/history.rs` (the renderer dispatch fallback).
- `native/src/io/autosave.rs` — `spawn(handle, …)` + `handle.subscribe()` (TS autosave is
  authoritative).
- The native MCP mutation surface: of the ~62 `native/src/mcp/tools.rs` handlers, delete the
  **TS-executed subset** — the ~46 in the §2.7 table (mutations + the TS-served reads) — plus the
  keyframe algorithms in `native/src/mcp/keyframes.rs`; all call `b.project()?` so they are dead
  under the flag. The read/compute/hybrid handler bodies (`list_motifs`/`get_motif_source`/
  `detect_silences`/`transcribe_clip`/`preview_motif_draft` + the hybrid-compute halves) **stay** —
  see §4.2 for the catalog coupling.
- The `replay`-feature constructors `Backend::{new,init}_for_replay` (`napi_backend.rs`) and the
  three driver bins — see §4.5.
- The dead Rust-write **`else` branches** of `jobs/mod.rs` `commit_media_derivatives`
  (≈ L90 `project.set_media_derivatives`) and `commit_media_workspace_paths` (≈ L125); the
  `if ts_derivative_authority()` event-emit arm stays (then simplifies — see §4.4).

**KEEP-BUT-REPOINT (compute that must read the mirror, not the actor):**
- `jobs/mod.rs` `fresh_media_item` — already re-pointed in 4a (§2.4).
- `commands/query.rs` ≈ L8 `project_summary` still calls `project().snapshot()`. Under the flag the
  renderer summary is served by TS (`buildProjectSummary`), so this is likely dead and deleted with
  the dispatch fallback; if any caller remains, repoint to `snapshot_for_read()`. Resolve in plan.

**KEEP (already mirror-backed or pure-native):**
- `napi_backend.rs` read-mirror infra: `read_mirror`, `set_project_mirror`, `snapshot_for_read`,
  `mirror_history_view` (after delete, `snapshot_for_read` is **always** the mirror — no actor
  fallback; see §4.6).
- The whole `state/` **model** (serde): `project`/`layer`/`track`/`media`/`ids`/`composition`/
  `time`/`animated`/`color`/`transform`/`marker`/`transition`/`group`/`effect`/`audio_role`/
  `keyframe_edits`. Rust deserializes the mirror and computes against it.
- The compute commands already on `snapshot_for_read` (`commands/export.rs`, `commands/media.rs`,
  `commands/motif_authoring.rs`), the hybrids, `mcp/resources.rs`, and all pure-native arms
  (ffmpeg/jobs/audio/export/probe/motif files/cloud/eval).
- `state/mod.rs`: drop the `pub use` re-exports of the deleted actor/history/validate symbols; keep
  the model re-exports.

### 4.2 Native MCP catalog split — move the mutation catalog to TS (your gap; decided)
`mcp/catalog.rs`'s `tool_table!` macro binds **schema and `dispatch_tool` handler inseparably**, and
`server.ts` ≈ L86 sources `ListTools` from Rust (`backend.mcpCatalog()` → `tool_catalog()`). So the
mutation handler bodies can't be deleted without also removing their schema, and the genuinely-native
tools share the same macro.

**Decision (chosen): split the catalog by execution engine.**
- Rust `tool_table!` keeps **only** the native tools (reads/compute/hybrids: `list_motifs`,
  `get_motif_source`, `detect_silences`, `transcribe_clip`, `preview_motif_draft`, resources, the
  hybrid-write tools' compute, etc.). Their schema + `dispatch_tool` arms stay coupled and live.
- The ~46 **TS-executed tools** advertise their `inputSchema` + `description` from the
  **single-source table built dormant in 4a (§2.7)** — schema and validator are two fields of one
  record, so they cannot drift. This slice is the only behavioral change: no tool definitions are
  re-touched here.
- `server.ts` `ListTools` flips to **merge(Rust-native catalog, TS table)**; `CallTool` already
  routes `ts` names → `actor.mcpCall`. The Rust MCP surface becomes **compute-only**.
- Delete `mcp/tools.rs` mutation bodies + `mcp/keyframes.rs`; the `tool_table!` macro shrinks to the
  native set.

Verified by the **§2.7 structural gate** (catalog↔handler bijection: merged ListTools is an exact
union, no advertised-but-unhandled / handled-but-unadvertised) **plus** the `mcp-flip` e2e (a real
MCP SDK client: ListTools shows the merged set; a TS tool executes against the actor; a native tool
reads the mirror). The structural gate is what closes the ListTools shape that was never corpus-gated;
the e2e is the end-to-end sanity check.

### 4.3 Startup-order hard constraint + test (your gap)
`index.ts` ≈ L213 `startMcpHost(backend, () => tsHost)` runs **before** ≈ L294 `tsHost.start()` and
the first `set_project_mirror`. At default-on this leaves a window where an MCP request resolves
`getTsHost() === null` and falls to the native (frozen) path. 4b **reorders bring-up** so the MCP
host starts only **after** the TS host is ready and the **initial mirror has been pushed** (or the
host rejects tool calls until ready). A regression test pins the order (the class of bug the
3c-ii-d `initEval` and 3d-d `<TS>`-sentinel e2es caught).

### 4.4 Flag plumbing removal
With no fallback, the flag is vestigial:
- `index.ts`: drop the `WEFTCUT_TS_ACTOR === '1'` branch — always create `tsHost`; drop the
  `WEFTCUT_TS_ACTOR_SHADOW` logging.
- `router.ts`: `BLOCKED_UNDER_FLAG` is ∅ after 4a; remove the flag-conditional rejection; the
  unclassified-channel default becomes an ordinary error, not a flag-gated one.
- `jobs/mod.rs`: `TS_DERIVATIVE_AUTHORITY` is always true → collapse `commit_media_*` to the
  event-emit arm; `set_ts_derivative_authority` becomes a no-op or is removed (and its `index.ts`
  call with it).

### 4.5 Differential-harness retirement (your four preconditions)
Strictly after 4a's final regen+commit and **only** when `skipped===[]` across all differential
gates:
1. **Tag `main` immediately before the 4b delete** (e.g. `state-corpus-frozen-pre-phase4b`) so the
   corpus is regenerable by checkout — this is the documented regen path.
2. Delete the `replay` Cargo feature, the three `[[bin]]` entries, the driver sources
   (`bin/replay_driver.rs`, `prod_driver.rs`, `mcp_driver.rs`), the `#[cfg(...replay...)] pub use`
   re-exports in `lib.rs`, and `scripts/gen-state-oracle.mjs`.
3. Keep the committed oracle fixtures + the `*.differential.test.ts` gates (TS replays the **frozen**
   oracles — still catches TS regressions; only regen is gone).
4. `fixtures/state-corpus/README.md`: state plainly that the oracles are **frozen**; regeneration
   requires checking out the pre-4b tag/commit.

### 4.6 The no-fallback bring-up risk
After the actor is gone, `snapshot_for_read()` has **no actor fallback** — if a compute read fires
before the first `set_project_mirror`, it has no project. Bring-up must guarantee the **mirror is
pushed before any compute path (renderer invoke, MCP, jobs) can run** — the same ordering discipline
as §4.3. Pin it in the plan and back it with the startup-order test.

### 4.7 4b exit criteria
Rust builds with **no `state` actor module** (`cargo build` + `napi:build`); all frozen-oracle
regression gates green; the three flag-on e2es pass as the **default** path (flag removed); the
soak-saved project reopens clean; 3-OS CI green; `native/index.d.ts` narrowed to the
media/export/cloud/motif/eval + read-mirror surface; the worktree bootstrap simplifies
(`reference_worktree_bootstrap`).

---

## 5. Final Rust boundary (the narrowed napi surface)
Post-4b, Rust is a focused media-compute lib: ffmpeg orchestration (import/proxy/conform/thumbnail/
waveform), audio DSP/mixer/conform/envelope, the export pipeline (IPC frame sink, mux, EOS-tail),
media probe, motif file resolution + capture + the **motif catalog** (`builtins()`/`canonicalize_props`/
`resolve_motif_max_dur_us` — now also feeding the `add_motif` hybrid + the TS manifest cache + the
golden cap fixture), cloud audio extraction, the `weftcut-eval` wasm leaf, the **read-mirror**, and a
**compute-only MCP catalog**. No project state, no mutations, no history, no validation, no autosave.

---

## 6. Risk register (deltas from the master plan)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A dangling actor consumer left after delete → broken build | Med | High | §4.1 census is the deletion backbone; `cargo build` + `napi:build` + 3-OS CI are hard gates |
| MCP catalog split drops/duplicates a tool, or schema↔parser drift | Low | Med | §2.7 single-source table (schema + parser = one record) **derives** the legacy name-keyed tables; the §2.7 structural bijection gate fails the build on any drop/dup/drift; `mcp-flip` e2e is the end-to-end check |
| Compute read before first mirror push (no fallback) | Med | High | §4.3/§4.6 bring-up reorder + startup-order regression test |
| Corpus frozen too early / not `skipped===[]` | Low | High | §4.5 preconditions; pre-4b tag makes regen recoverable |
| `add_motif` hybrid mis-mints ids (track id from Rust) | Med | High | Contract returns a track *plan*, not an id; TS mints in two-commit order; differential-gated |
| LogBus record-panel parity missed at default-on | Med | Low | §2.1 adds the TS-host log emit for restore + sibling history/checkpoint ops |
| Motif cap helper drifts from Rust | Low | Med | Golden fixture (`snap_frame_golden` precedent); bounded helper |

---

## 7. Open items for planning (non-blocking)
- §2.1 renderer-restore prod-differential seeding (debug create vs MCP-corpus + alias).
- §4.1 `commands/query.rs project_summary` — confirm dead-under-flag (delete) vs surviving caller
  (repoint).
- ~~Exact final shape of the TS MCP mutation-catalog module~~ — **decided (§2.7):** one record per
  TS-executed tool; `MCP_TOOLS`/`MCP_ARG_PARSERS`/`MCP_RESULT_SHAPERS` become projections. Residual
  (mechanical): file placement — extend `mcp-commands.ts` vs a new `mcpCatalog.ts`. Settle in the plan.
- Whether 4a or 4b owns the `index.ts`/`server.ts` bring-up reorder (lands as part of flag removal,
  but the *test* could be authored in 4a against the flag-on path).

## 8. Out of scope (YAGNI)
- The master plan's optional **patch-push IPC** optimization (Immer inverse patches instead of
  signal+pull). Signal+pull works; defer indefinitely.
- Porting `canonicalize_props` to TS (the hybrid decision avoids the twin).
- Any renderer view-type unification beyond what the boundary narrowing forces.

---

## 9. Decision log (this brainstorm, 2026-06-25)
1. **Two slices** — 4a port+gate against the live actor (last regen) → flip default-on + targeted
   soak → 4b irreversible delete (corpus frozen). [forced by §1]
2. **`add_motif` = hybrid** (Rust validates/resolves, TS applies; no canonicalize twin), with the
   track-*plan* (not id) contract and separate renderer/MCP gating.
3. **4a→4b gate = brief default-on soak of the three never-soaked paths**, then delete.
4. **Parser-discipline hardening folded into 4a**, restated as "every pre-commit unknown→type
   adapter must be parser-gated," plus the subscriber-starvation defense.
5. **MCP catalog: move the mutation-tool catalog to TS** (Rust MCP = compute-only; schema
   single-sourced with the parsers).
6. **Replay drivers deleted in 4b** under the four preconditions (final regen, `skipped===[]`,
   delete feature/bins/re-exports/gen-script, README frozen-note + **pre-4b tag** for regen).
7. **Schema/exec split closed by construction (§2.7):** one single-source record per TS-executed tool
   (schema + parser + shaper); the legacy name-keyed tables become projections; built **dormant in
   4a** so parser-hardening lands once and a permanent structural bijection gate is authored before
   the irreversible delete. 4b only flips `ListTools` to the merge + deletes the Rust mutation
   catalog. [strengthens decision 5 — "single-sourced" made an invariant, not a placement convention]
