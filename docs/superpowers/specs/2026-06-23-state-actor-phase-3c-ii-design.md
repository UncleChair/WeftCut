# State-actor TS migration — Phase 3c-ii design (the authority flip)

**Date:** 2026-06-23
**Slice:** 3c-ii — make the TS state actor authoritative in Electron main, replacing the Rust actor for the renderer/main-process path
**Status:** design approved; pending implementation plan

## Context

Phases 0–3c-i built and corpus-gated the TS state actor's **mutation engine**: model, validation,
history, every recorded/unrecorded mutation, and the media-pool surface — all proven
byte-identical to the Rust actor by the differential harness (174 state oracles + 174
summary oracles, det-id replay). The Rust actor is still authoritative; the TS actor does
not yet serve the renderer.

3c-ii is **the authority flip**: the TS actor (in main) becomes the single source of truth
for the renderer and main-process subsystems, and the Rust actor stops serving them. The
Rust state actor is kept as a launch-flag fallback until Phase 4 deletes it. The full MCP
handler port stays **3d** (after this slice).

## Three findings that reshape the slice (verified against code)

**F1 — the TS actor's `dispatch()` is a *corpus vehicle*, not the production command layer.**
`SUPPORTED_OPS` / `dispatch()` (`actor.ts:322`, `replay.ts:10`) speak the **replay-driver**
vocabulary, not the renderer's:

| Replay vocab (`dispatch`) | Real renderer/MCP wire |
|---|---|
| `add_layer` + `kind` — hardcodes `textParamsDefault('hello')`, `colorParams(red,1920,1080)` | `add_color_layer` / `add_text_layer` / `add_media_layer` with **real** `color`/`width`/`content`/`mediaId` |
| `separate_audio`, `split_layer` | `separate_audio_to_new_track`, `split_layer_grouped` |
| `add_media` (minimal `mediaItemTemplate`) | media imported by the Rust import pipeline, not a renderer command |
| snake_case args (`a.layer`, `a.to_track`) | camelCase wire (`layerId`, `newTrackId`, `tStartUs`); Rust structs are `#[serde(rename_all="camelCase")]` |

The differential corpus has proven the **mutation engine**; it has **not** exercised a
production command layer, because none exists in TS. The renderer IPC (`src/renderer/ipc/index.ts`,
~1458 lines) sends specific channel names + camelCase rich args; Rust parses them in
`commands/mod.rs` arg-structs and dispatches via `napi_backend.rs` `invoke` (≈386). **The new
TS production command adapter is the single genuinely un-gated surface of the whole migration.**

**F2 — the flip is atomic to production, not incremental.** The instant the TS actor owns
mutations, the Rust actor is stale. Autosave **reads** the Rust actor (`io/autosave.rs`
`handle.subscribe()`); the jobs callback **writes** it (`jobs/mod.rs` →
`project.set_media_derivatives(actor_for_jobs(), …)`); persistence save/open
**snapshot/replace_state** on it (`commands/persistence.rs`). All four must move together.
So 3c-ii's sub-slices are a **build order behind one launch flag**, flipped as a unit.

**F3 — live shadow has an id-divergence problem.** Production Rust mints `Uuid::now_v7()`;
the TS actor mints its own (`ids.rs` det mode is OFF in production). Their canonical states
never match id-for-id, so a *live* shadow can only compare modulo-ids — strictly weaker than
the det-id differential gate that carried phases 0–3c-i. **Decision (below):** the primary
gate is a det-id differential on the production command surface, not live shadow.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Gate the new command adapter with a production-channel differential** (det-id oracle + TS production corpus + new gate), not live shadow. | Same mechanical-equivalence discipline that made 0–3c-i safe, applied to the surface most prone to field-name drift. Live shadow stays an optional confirmatory dev tool. |
| D2 | **Four sub-slices**, each its own spec→plan→SDD cycle: **a** adapter+prod-differential · **b** persistence+napi · **c** autosave+jobs · **d** flip. | Matches the 3c-i cadence; keeps the distinct test surfaces separable. |
| D3 | **Command adapter = a parallel production entrypoint** reusing the gated mutation core (`commit`/`runValidate`/the closures/`apply*`). `dispatch()` stays untouched (it guards 161 oracles). Wire-arg parsing lives in a pure, unit-testable `commands.ts`. | Two thin adapters (replay + production) over one gated engine — mirrors Rust's `commands::mutations` + thin UI/MCP adapters. |
| D4 | **Persistence is TS-orchestrated via granular napi.** TS owns snapshot→serialize and load→`replaceState`; Rust keeps cache/recents/LogBus/workspace/agent-session/jobs-enqueue/schema-migrate behind a small napi surface. | Puts orchestration where it permanently lives; shrinks Rust toward the focused media-compute endgame; cleaner into Phase 4. |
| D5 | **Jobs write-back = event-based, fire-and-forget.** Rust job-complete emits `media:derivatives {media_id, patch}` → `onEvent` in main → TS `set_media_derivatives`. The Backend is told the authoritative engine at init (from the flag); flag-off keeps today's in-Rust call. | Reuses the existing `onEvent` bridge; decouples Rust jobs from the actor; jobs don't need a reply. |
| D6 | **At the flip, pause agent (MCP) mutations during the soak.** 3c-ii flips the renderer/main path only. While the flag is on, MCP category-A mutation tools are disabled — single-writer invariant. Full MCP port stays **3d**. | Avoids two writers diverging without front-loading 3d. Cost: agents can't edit during the dev soak. |
| D7 | **One launch flag `WEFTCUT_TS_ACTOR` (default off)** gates the whole cutover atomically. Cutover criteria: prod-differential green + e2e green + manual soak. Rust state stays a fallback until Phase 4. | Atomic flip (F2); reversible during bring-up. |

## Sub-slice topology

### 3c-ii-a — Production command adapter + production differential gate (mechanically gated)

- **`src/main/state/commands.ts`** (new, pure) — parse each category-A **production** channel's
  camelCase wire args into typed mutation inputs, including rich `LayerParams` construction
  for `add_color_layer` (real `color`/`width`/`height`), `add_text_layer` (real `content`),
  `add_media_layer` (resolve `mediaId` from the pool, build `VideoClip`/`Audio`/`ImageOverlay`
  by media kind). Channel-name reconciliation for the renamed/split channels
  (`separate_audio_to_new_track`, `split_layer_grouped`, the `add_*_layer` family).
- **Production entrypoint on the actor** — a sibling to `dispatch()` (e.g. `command(channel, wireArgs)`)
  that reuses `commit`/`runValidate`/the closures. Exact placement (method vs module fn) is a
  plan detail; it must reuse the gated core, not re-implement mutations.
- **Rust prod-oracle** — drive the **real production path in det mode**. The current
  `replay_driver` calls the actor API directly (`h.add_layer(…)`), bypassing `commands/`. The
  prod-oracle must instead run `commands/mod.rs` dispatch under det ids — concretely a det-mode
  test `Backend` calling `invoke(channel, camelCaseArgsJson)` (det mode is process-global on
  `new_id()`, so it threads through). Captures canonical state per step into a **new corpus
  dimension** (e.g. `fixtures/state-corpus/oracle-prod/`), additive to the 174 state + 174
  summary oracles.
- **TS production corpus** — sequences of `{channel, camelCaseArgs}` that finally **vary the
  rich args** (real colors/text/media params) the replay corpus had to hardcode.
- **New gate** — `commands.differential.test.ts`: TS adapter vs prod-oracle, per-step canonical
  state + `ok` + error-variant, `skipped===[]`. The emitted `project:changed` payload may also
  be captured per step (normalizing `op_id`/`timestamp`).
- **No live wiring.** Deliverable: "the TS actor faithfully executes every production category-A
  command, proven byte-equal to Rust."

### 3c-ii-b — Persistence re-home + napi boundary (behavioral: unit + e2e)

TS-in-main owns the `project_open`/`save_as`/`new_workspace` sequence:

- **Load** (`project_open`): read `project.json` bytes; the 3b pieces do parse + `schemaGate` +
  `reconcileMediaPaths(dir, node:path.join)` + `clearSessionQuickProxies` (wire the `fs` delete
  of the returned stale-proxy list); `actor.replaceState`. **Caveat to confirm in the plan:**
  whether `io/migrate.rs` does real version *transforms* (vs just gating). If it transforms,
  the read+migrate stays a Rust napi call (`loadProjectBytes(path) → migrated JSON`); parse/
  reconcile/quick-proxy remain TS.
- **Save** (`save_as`): `actor.snapshot()` → `serializeProjectToJson` (3b) → TS writes the bytes
  into the workspace (an allowed `fsGuard` root). Confirm `io::save_to_dir` has no sidecar/
  atomic-rename behavior the TS write must replicate.
- **New blank** (`new_workspace`): `blankProject` + canvas override → `actor.replaceState` →
  serialize+write.
- **Granular napi (new) for Rust-native orchestration** — `commitWorkspace(path, kind)`:
  `cache.set_workspace`, `workspace.set`, `agent_session::end_and_emit`, `LogBus::spawn`,
  `recents.push` (+ `set_last_new_project_parent` for new); and `enqueueJobsForMedia(mediaList)`
  for open's derivative re-fan-out. TS orders the sequence (load → replaceState → commitWorkspace
  → enqueue), so any `project:changed` consumer sees the new workspace before asking for paths
  (preserves the Rust handler's documented ordering).

### 3c-ii-c — Autosave port + jobs write-back seam (behavioral: unit + e2e)

- **Autosave (`src/main/state/autosave.ts`)** — port `io/autosave.rs`: subscribe `actor.subscribe`;
  500ms debounce; `serializeProjectToJson` → write; **Backups** rotation (keep 20; snapshot every
  50 commits or 5 min, whichever first; colon-free `YYYYMMDDThhmmssSSSZ` timestamps that sort
  lexicographically = chronologically); a `forceFlush()` for save/quit gates.
- **Jobs seam** — D5. Rust job-complete emits `media:derivatives {media_id, patch}`; main applies
  it to the TS actor. **Care:** the patch's `Option<Option<PathBuf>>` proxy fields must serialize
  faithfully over JSON — `skip_serializing_if = "Option::is_none"` on the outer `Option` yields
  exactly absent/`null`/string, matching the 3c-i `'key' in patch` tri-state contract.

### 3c-ii-d — The flip + safety ramp (integration + cutover)

- **`backend:invoke` splitter** (`src/main/index.ts:190`) — when `WEFTCUT_TS_ACTOR` is on, route
  the ~44 category-A channels to the TS production adapter (routing key derived from the adapter's
  channel set, the production analogue of `SUPPORTED_OPS`); the ~17 media/jobs/cloud/motif channels
  keep forwarding to `backend.invoke`. Route `project_summary` + history queries to the gated TS
  `buildProjectSummary`.
- **Event emission** — the TS actor's `subscribe` stream drives `evt:project:changed` (renderer)
  and `mcp:change` (MCP host) with the **same payload shape Rust emits**: `op_id`, `actor_kind`
  (`user`/`agent`), `client`, `summary`, `timestamp` (RFC3339), `affected_count`
  (`napi_backend.rs` ≈155).
- **MCP** — D6: pause agent category-A mutations while the flag is on.
- **Ramp** — ship a–c behind the flag (default off); flip the flag in dev, soak; optional live
  shadow (modulo-ids) as a confirmatory check; then default on. Rust state stays a fallback.

## Key risks / landmines

1. **Adapter field-name drift** (F1) — the exact class the prod-differential exists to catch.
   The Rust arg-structs are camelCase (`AddMediaLayerArgs.track_id` ← `trackId`); the param
   construction for `add_*_layer` is where real args get dropped today. The corpus must vary
   every such field.
2. **Det-mode prod-oracle feasibility** — must confirm `commands/mod.rs` dispatch (via a test
   `Backend.invoke`) produces det ids end-to-end and that category-A commands don't require live
   cache/jobs to execute. Det toggle is global on `new_id()` (`ids.rs:20`), so the mechanism is
   plausible; the plan verifies it before authoring the corpus.
3. **Jobs tri-state over the wire** (D5) — `MediaDerivativesPatch` JSON must preserve absent vs
   `null` vs string for `proxy_path`/`quick_proxy_path`.
4. **`migrate.rs` transforms vs gating** (3c-ii-b caveat) — determines how much load logic is TS.
5. **Single-writer during soak** (D6) — the flip must actually disable MCP category-A mutations
   when the flag is on, or two writers diverge.
6. **Ordering in `project_open`** — derivative-path consumers reacting to `project:changed` must
   see the new workspace first; TS must call `commitWorkspace` before broadcasting / enqueueing.

## Exit gates

- **3c-ii-a:** `commands.differential.test.ts` — production corpus, `skipped===[]`, per-step
  canonical state + `ok` + error-variant identical to the det prod-oracle; existing state +
  summary oracles byte-identical (additive regen); `tsc` clean.
- **3c-ii-b/c:** unit tests (persistence orchestration, autosave debounce/rotation, jobs tri-state)
  + Playwright `_electron` e2e (open/save/new round-trip; autosave + Backups; a job completing
  writes derivatives to the TS actor) behind the flag.
- **3c-ii-d:** e2e with `WEFTCUT_TS_ACTOR=1` (edit → timeline updates → save → reopen → identical);
  manual soak; then default-on. All prior differential gates stay green.

## Carry-forwards into 3d / Phase 4

- **⚠️ 3d-e (NEW; 2026-06-24 audit) — gates flag-default-on:** D7's "flag-on after soak"
  has an unstated prerequisite. The renderer-side native-compute channels left on Rust
  (`export_project_audio_only`/`ensure_export_audio_conform`/`import_media`/`ensure_full_proxy`/
  `ensure_conform`/`get_media_thumbnail`/`get_waveform_peaks`/`motif_staleness_report`/
  `acknowledge_motif_staleness`) read/write `backend.project()` → blank/stale under the flag.
  They MUST be re-pointed to take TS-snapshot/explicit-args input **before
  `WEFTCUT_TS_ACTOR` goes default-on**. Full record + the 3d-e slice + gates:
  `specs/2026-06-24-state-actor-phase-3d-design.md` §"Post-flip audit".
- **3d (MCP handler port):** re-point the 44 category-A tools to the TS actor (thin re-points +
  the rich MCP-only logic: 8 keyframe algos, checkpoints, `apply_subtitles`, `dry_run`,
  `project://` resources, `begin_agent_session`); un-pause agent mutations.
- **Phase 4:** delete the Rust state actor; narrow napi (remove the kept-fallback paths + the
  state-serving `invoke` arms); the persistence orchestration already lives in JS (D4).
- **`parseProject` structural conformance** (Phase-1 carry-forward (a)) — still a bare cast; the
  prod-differential + 3b round-trip catch field-NAME/value drift but not an undeclared *new* Rust
  field. Add structural validation when 3c-ii-b wires real `.vproj` reads.
- **Deferred from 3c-i:** the `proxy_bypassed`/`export_uses_original` `true`-set differential seq
  and the force-remove-of-grouped-layer parity seq (unit-tested only) can fold into the prod corpus.
