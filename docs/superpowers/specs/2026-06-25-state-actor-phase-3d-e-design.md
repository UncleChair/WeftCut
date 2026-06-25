# State-actor TS migration — Phase 3d-e design (native-compute input re-point)

Date: 2026-06-25. Status: brainstormed + approved (leaner hybrid; no catalog port).
Predecessor: Phase 3d-d (THE MCP FLIP). Under `WEFTCUT_TS_ACTOR` (default OFF) the TS
state actor is authoritative for the renderer + MCP paths; the Rust actor is frozen at
blank init and is the flag-off fallback until Phase 4. 3d-d added the **read-mirror**
(`napi_backend.rs` `ReadMirror` / `set_project_mirror` / `snapshot_for_read` /
`mirror_history_view`), which the TS host pushes on every `project:changed`.

## Goal

Close the **native-compute stale-actor gap** (the 2026-06-24 post-flip audit, findings
F1–F7 in `specs/2026-06-24-state-actor-phase-3d-design.md` §"Post-flip audit"). A class
of renderer + MCP `backend.invoke` channels routed to Rust still READ or WRITE the
project actor for their inputs. Under the flag the Rust actor is blank, so they operate
on stale/blank state — silent wrong audio export (F1/F2), split-brain media import (F3),
a derivative write that bypasses the TS seam (F4), and stale media/motif reads (F5/F6/F7).
This violates the single-writer invariant. **3d-e is the last prerequisite before
`WEFTCUT_TS_ACTOR` can go default-on** (3c-ii spec D7); deferring to Phase 4 is unsafe
because the flag can flip on after the soak, before Phase 4 deletes Rust state.

**Principle (carried from the audit):** Rust may keep the ffmpeg/audio/export/probe/TTS
compute, but its project/media INPUT must come from the TS actor (mirror snapshot or
explicit args) and its project WRITES must go through the TS actor — never
`backend.project()`.

## Scope decisions (this brainstorm)

- **D1 — No catalog port this slice.** `do_rebind_motif` (`actor.rs:3711`) is a trivial
  precomputed-updates mutation (set `motif_id`/`motif_version`/`props` on the named
  layers, one commit) with **no catalog dependency**. The catalog/schema-aware compute
  (`build_rebind_updates` → `canonicalize_props_lenient`, `authoring_commands.rs:269`)
  reads the **Rust motif store** and stays Rust. So the motif WRITE re-point is the same
  "native-compute → TS-write" hybrid as the others — it does **not** require porting
  `motif_cap_us`/`builtins()` to TS. The catalog port, `add_motif` (creating a *new*
  motif layer genuinely needs the catalog to seed the content-window), and the
  `update_layer_params` Motif content-window clamp all stay **Phase 4**.
- **D2 — Single slice.** One spec → plan → SDD covering F1–F7 + the durable
  architectural gate + the flag-on e2e.
- **D3 — `acknowledge_motif_staleness` is explicitly in the hybrid-write set** (Group C),
  alongside `install_motif` (Update mode), `import_media`, `apply_subtitles`,
  `synthesize_speech`.

## The unifying pattern — "native-compute → TS-write hybrid"

Under the flag, every write-bearing native channel splits into:
1. **Rust native compute** — probe/hash/parse/TTS/rebind-compute — reading the
   **mirror** (`snapshot_for_read`) where it needs project state and the Rust motif
   store where it needs manifests; produces a serializable result (a `MediaItem`, parsed
   cues, a `MotifRebindEntry[]`, …). **No `backend.project()` write.**
2. **TS write application** — the TS host calls the existing gated actor mutations
   (`add_media_item` / `add_caption_track` / `rebind_motif` / `add_media_layer`) and
   returns.

This is the 3c-ii-b/d persistence-orchestration shape reused: TS owns writes; Rust
exposes granular compute napis. It plugs into **two** orchestration seams:
- **renderer** — `ts-actor-host.ts` `handleInvoke` (a new `Route` kind);
- **MCP** — `server.ts` `handleCallTool` + `routeMcpTool` (a new `McpRoute`).

Reads that don't write get the cheaper treatment (Group A): the Rust handler simply
reads `snapshot_for_read()` and the channel stays `{kind:'rust'}`.

---

## Components

### A. Read re-points (mechanical; channels stay `{kind:'rust'}`)

Swap `backend.project()?.snapshot().await` → `backend.snapshot_for_read().await`. These
handlers keep `backend.project()` only for the job handle they pass to `enqueue_*`
(whose derivative write-backs are already TS-seam-routed via `commit_media_derivatives`,
3c-ii-c; the handle is inert-under-flag for writes, and stale freshness reads are the
accepted F9/Phase-4 `fresh_media_item` cleanup):

- **F1** `export_project_audio_only` (`commands/export.rs:34-36`) — read-only snapshot.
- **F2** `ensure_export_audio_conform` (`commands/export.rs:107-113`) — read snapshot;
  keep `handle` for `enqueue_conform`.
- **F5** `ensure_conform` (`commands/media.rs:189-190`) — read snapshot; keep `handle`
  for `enqueue_conform`.
- **F6** `get_media_thumbnail` / `get_waveform_peaks` (`commands/media.rs:142-143,154-155`)
  — pure read.
- **F7-read** `motif_staleness_report` (`commands/motif_authoring.rs:61`) — pure read
  (+ its LogBus emit, unaffected).

### B. F4 `ensure_full_proxy` write-seam fix (`commands/media.rs:165-185`)

Read via `snapshot_for_read()`; route the direct
`handle.set_media_derivatives(Agent{jobs}, id, {export_uses_original:false})` through
`crate::jobs::commit_media_derivatives(&backend.events, handle, id, patch)` — the
existing TS-authority seam (under the flag → emits `media:derivatives` → TS
`applyDerivativesEvent`; flag-off → writes the Rust actor as today). Keep `handle` for
`enqueue_full_proxy`.

### C. TS-orchestrated hybrid writes (new Route kind; un-blocks the MCP equivalents)

Each gets a granular Rust **compute** napi (no actor write) and a TS **write** step. The
MCP versions are removed from `MCP_BLOCKED_UNDER_FLAG` (`mutationTools.ts:9`) and the
renderer `import_media`/motif channels get a new `router.ts` Route.

| Hybrid | Rust compute napi (new/extracted) | TS write | Returns |
|---|---|---|---|
| **F3 `import_media`** (renderer + MCP) | `probe_media(path) → MediaItemJson` (the probe/hash/`detect_kind` body of `media.rs:47-83`, no `add_media_item`) | `actor.add_media_item(item)` then kick derivative jobs via the existing `enqueueDerivatives` seam + workspace-copy enqueue | media id |
| **`apply_subtitles`** (MCP) + the `import_media` **subtitle branch** (`media.rs:31-40`) | `parse_subtitles(body, format?) → {cues, simplified, label}` (the parse half of `import_subtitles`, `mutations.rs:709`) | `actor.add_caption_track(cues, label)` | track id (+ `simplified`) |
| **`synthesize_speech`** (MCP, `cloud` feature) | `synthesize_speech_compute(args) → {mediaItemJson, t_start_us, t_end_us, cached}` (TTS + content-addressed cache, no actor write — the compute half of `tools.rs:2673`) | `actor.add_media_item(item)` + place a layer | `{layer_id, media_id, t_start_us, t_end_us, cached}` |
| **`install_motif`** Update mode (`motif_authoring.rs:45`) | store ops (publish: `write_draft`/`install_draft`) **stay Rust**; `compute_motif_rebind_updates` reads the **mirror** + Rust store manifest → `MotifRebindEntry[]Json` (the `build_rebind_updates` body) | `actor.rebind_motif(updates)` (skip if empty) | published id |
| **`acknowledge_motif_staleness`** (`motif_authoring.rs:83`) | compute ack entries from the **mirror** + Rust store (`build_ack_entries`) → `MotifRebindEntry[]Json` | `actor.rebind_motif(updates)` | count |

New TS actor work for C:
- **`rebind_motif`** on `ActorHandle` + an `actor.command`/`mcpCall`-reachable arm — a
  1:1 port of `do_rebind_motif` (set fields on matching `Motif`-param layers, one
  `commit` with `DiffHint::Coarse`, `affected` = the layers). Differential-gated (see
  gate) with a **literal** motif-layer corpus builder added to `replay_driver` + TS
  replay (`MotifParams` already exists in `model.ts:52`; the builder supplies literal
  `motif_id`/`motif_version`/`props` + a literal span — no catalog).
- The renderer `import_media`, `install_motif`, `acknowledge_motif_staleness` channels
  and the un-blocked MCP hybrids route through the new hybrid orchestration in the host
  / `handleCallTool`, which needs a compute-napi facade injected into the host deps.

`New`-mode `install_motif` does store ops only (no rebind) — it already touches no actor
and is safe; only the Update-mode rebind is the gap.

### D. Durable architectural gate (the #1 guard)

A mechanical test that fails CI if **any** project-actor-touching channel routes to Rust
under the flag — it would have caught F1–F7 and prevents regression. Design:
- Make `router.ts` explicit: replace the catch-all `default: {kind:'rust'}` with curated
  `PURE_NATIVE` (compute that reads only the mirror or args) + `PERSISTENCE` allowlists;
  an unclassified channel routes to a loud `reject` (forces a routing decision on every
  new channel).
- The gate asserts the full renderer-channel manifest (the `napi_backend.rs` dispatch
  arms) is **partitioned** across `PRODUCTION_OPS` ∪ hybrid ∪ persistence ∪ `PURE_NATIVE`
  ∪ `BLOCKED_UNDER_FLAG` ∪ the fixed special cases — nothing falls through unclassified.
- A Rust-side assertion that the `PURE_NATIVE` handlers read `snapshot_for_read()` and do
  not reference `backend.project()` (mechanism finalized in the plan — a source-scan test
  or handler purity tags; it MUST be mechanical, not a manual list).

### E. Flag-on e2e (`e2e/electron/*.spec.ts`, the 3c-ii-d/3d-d harness)

Under `WEFTCUT_TS_ACTOR`: (a) import a media file → assert it appears in TS
`project_summary` (catches F3 split-brain); (b) export audio → assert the rendered audio
matches the TS project, not blank (catches F1/F2 silent-wrong-output). Motif rebind
exercised via the differential gate; a UI-level motif e2e is optional.

---

## Gates / definition of done

- New differential coverage where state-bearing: a `rebind_motif` arm gated in the
  appropriate corpus dimension (`differential.phase2` for the renderer command vehicle,
  and/or `mcp.differential` for the MCP arm) with a literal motif-layer builder; existing
  `differential.phase2`/`summary.differential`/`persistence.differential`/
  `commands.differential`/`mcp.differential` all still green, all `skipped===[]`; corpus
  additivity proven (`git diff --diff-filter=M fixtures/state-corpus` = ∅).
- The durable architectural gate (D) green and would-have-caught-F1–F7 (demonstrated by
  temporarily reverting one re-point in review, or an inline negative assertion).
- Flag-on e2e (E) passes; full vitest suite; `tsc -b` clean; Rust lib tests pass.
- Final opus whole-branch review READY-TO-MERGE with zero Critical/Important.
- Flag stays default-OFF — flipping default-on remains the user's post-soak call (D7);
  3d-e only *unblocks* that flip.

## SDD plan shape (preview — finalized by writing-plans)

Rough task order, mechanical-first then the architectural seam:
1. **Architectural gate first (TDD discovery)** — build the `router.ts` explicit
   allowlists + the partition/purity gate; let it enumerate the current violations and
   confirm they are exactly F1–F7 (fail → red, the work-list).
2. **Group A read re-points** + **B** (F4 seam) — mechanical Rust edits; gate goes green
   for the read/seam findings.
3. **`rebind_motif` TS port** + literal motif-layer corpus builder + differential gate.
4. **Hybrid orchestration core** — the new renderer `Route` + `McpRoute`, the
   compute-napi facade injected into the host, and the `import_media` hybrid end-to-end.
5. **Remaining hybrids** — `apply_subtitles` (+ subtitle import branch), motif
   `install_motif`/`acknowledge_motif_staleness`, `synthesize_speech`; un-block in
   `MCP_BLOCKED_UNDER_FLAG`.
6. **Flag-on e2e** + audit + corpus-README update + full-suite/typecheck verification.

## Constraints (carried)

- wasm eval leaf is sacred; keep `snap.ts`/`renderer/eval` pure (engine-source-drift,
  snap-math-drift goldens).
- `TimeUs = number` is safe; preference patches stay unrecorded.
- Evergreen docs: this spec/plan is a dated snapshot; design docs in `docs/` stay
  date/phase-free.
- Granular napi additions follow the 3c-ii-b precedent (extract verbatim, feature-gate as
  the source command is — `jobs`/`export`/`cloud`/`motifs`); `native/index.d.ts` is
  gitignored → regenerate the bindings in the implementation env.
- Rides the command-surface unification (`commands/mutations.rs` Step-1a) — re-points
  that one impl at the TS actor.

## Out of scope (→ Phase 4)

Motif catalog in TS (`motif_cap_us`/`builtins()`), `add_motif`, the `update_layer_params`
Motif content-window clamp, deleting the Rust state actor + the kept-fallback `invoke`
arms + dead Rust autosave/jobs paths, and the `fresh_media_item` stale-read cleanup (F9).
