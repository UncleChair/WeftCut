# Design: Rust as a stateless in-process compute service

## Problem

Today the TypeScript main-process actor owns project state, but the Rust core
keeps a **full-project read-mirror**. On every commit, `ts-actor-host.ts`
serializes the whole project (pretty-printed) plus the last 100 history
entries and pushes them over napi; `Backend::set_project_mirror`
(`napi_backend.rs:163`) deserializes the entire `Project` into an
`Arc<Project>`.

The mirror is **written on every edit** (including drag bursts) but **read
rarely**, and most readers need only a slice:

| Reader | Call sites | Needs |
|---|---|---|
| `ensure_conform`, `ensure_full_proxy`, `get_media_thumbnail`, `get_waveform_peaks` | `commands/media.rs` (×4) | one `MediaItem` (by `media_id`) |
| `detect_silences`, `transcribe_clip` | `mcp/tools.rs:115,732` | one layer + its `MediaItem` (resolve clip audio source) |
| `export_project_audio_only`, `ensure_export_audio_conform` | `commands/export.rs:34,106` | the full project (audio mix plan) |
| `project://current`, `project://history`, `media://` | `mcp/resources.rs` | state views |
| background derivative jobs | `jobs/mod.rs::fresh_media_item` | freshest `MediaItem` at ffmpeg-start |

The mirror is also a standing **synchronization liability**: a copy of state
that can go stale, double-serialized on the hot path, and (as the recent
`io/{mod,migrate}.rs` cleanup showed) a magnet for hand-mirrored twins.

## Goal

Make the state-management boundary self-evident: **TypeScript owns ALL project
state; the Rust core holds none.** Every Rust compute call becomes a pure
function `(request + the exact state slice it needs) → result`. Delete the
resident mirror entirely. The driver is **boundary clarity**, not a measured
perf bottleneck (the cheap perf wins — lazy deserialize, compact JSON — are a
separate, smaller lever and out of scope here).

## Principle

Rust stays an **in-process napi addon** — NOT a separate OS process. Going
out-of-process would contradict [ADR 0024](../../adr/0024-desktop-runtime-electron-napi.md)
(in-process was chosen for near-zero call cost) and would make the
state-transfer cost strictly worse (every compute call cross-process). "Service"
here means *stateless request/response*, not *separate process*.

## Design

### 1. Slice protocol (per reader)

Each `snapshot_for_read()` caller receives the state it needs as a call
argument. **Reuse existing serialization** — `MediaItem` and `Project` already
(de)serialize; do not invent slice DTOs.

- **Single-`MediaItem` reads** (`commands/media.rs`): TS passes the `MediaItem`
  JSON for the `media_id`. The four channels (`ensure_conform`,
  `ensure_full_proxy`, `get_media_thumbnail`, `get_waveform_peaks`) gain a
  media-item parameter; they no longer call `snapshot_for_read`.
- **Clip-audio reads** (`detect_silences`, `transcribe_clip`): TS passes the
  resolved layer + its `MediaItem` (the inputs `resolve_clip_audio_source`
  needs).
- **Audio export** (`export_project_audio_only`, `ensure_export_audio_conform`):
  TS passes the **full project JSON** in the request. Export is user-triggered
  and infrequent, so a one-shot full serialize is fine; the video sink and mux
  channels are already `PURE_NATIVE` (no state).
- **MCP resources** (`project://current`, `project://history`, `media://`):
  served **by the TS MCP host directly**. TS already owns the authoritative
  state and builds the summary (`summary.ts`), the history view
  (`actor.historyView`), and canonical JSON (`canonical.ts`). Routing these
  reads to TS is forced by zero-state and natural (the MCP host already runs in
  main).

### 2. Import / derivative-pipeline rework (heaviest phase)

The jobs reader is the one that resists pure statelessness, because derivative
jobs are enqueued **before the content hash is known**. In the
`has_workspace` path, `probe_media_item` (`commands/media.rs:18`) does NOT hash
— it stamps a `pending-{media_id}` placeholder and defers the real blake3 to
the copy worker. Derivative jobs therefore run against the `pending-{id}` cache
key, and the copy worker later runs a **migrate fallback**:

1. `cache::migrate_hash_artifacts(pending → real)` renames cached files on disk;
2. `commit_media_workspace_paths` writes the real hash/paths back to TS;
3. `patch_derivative_paths_after_hash_migration` **reads the read-mirror** for
   the item's derivative path fields and string-rewrites `pending-{id}` → real
   hash.

This fallback is unsound as a foundation for zero-state:

- **Step 3 is itself a mirror reader** (`import.rs:317,449`) — the mechanism we
  would "rely on" depends on the mirror we are deleting.
- **One-shot race**: migrate/patch runs once at copy-finalize. A derivative job
  that commits its `pending-{id}` path *after* the patch (still encoding, or
  starting after finalize) is never rewritten → orphaned artifact, item points
  at a hash-keyed path with no file. `fresh_media_item` only partially mitigates
  this today; removing it without removing the pending window makes it worse.
- **Silent best-effort** (`warn!`-only) and a **stringly-typed path rewrite**.

**Resolution — remove the cause, not patch the symptom (variant B):** make the
real hash known *before* derivative enqueue, then enqueue jobs with the real
hash baked in. The whole `pending`/migrate apparatus disappears.

Flow:

- **Item appears instantly**: probe stays stat-only, so the clip shows in the
  timeline immediately. Its hash field is a **provisional value that is never
  used as a cache key** because no derivative job runs yet (the exact provisional
  representation — sentinel vs. an explicit "hash pending" flag on `MediaItem` —
  is pinned in the implementation plan).
- **A lightweight hash step** computes the real blake3 of the source (a fast
  read pass, not a transcode).
- **On hash-ready**, TS sets the real hash on the item and **enqueues the
  derivative jobs reading the source** (jobs are content-addressed by hash, so
  reading source vs. workspace copy is equivalent — `import.rs:8`).
- **The workspace copy runs in parallel.** Cost vs. today: one extra full read
  of the source (the standalone hash pass), accepted to keep derivatives
  starting promptly instead of waiting for the full copy.

Delete after this phase: `pending_hash_for`, the `migrate_hash_artifacts` call
(and the cache fn if it has no other caller), `patch_derivative_paths_after_hash_migration`,
`rewrite_hash_in_path`, and `fresh_media_item`.

### 3. Deletion

Once every reader takes its slice at call time, delete:

- `napi_backend.rs`: the `read_mirror` field, `set_project_mirror`,
  `snapshot_for_read`, `mirror_history_view`, `read_mirror_handle`, the
  `ReadMirror` struct.
- `ts-actor-host.ts`: the per-commit serialize + `setProjectMirror` push (the
  UI `project:changed` event is unchanged — the renderer still re-pulls
  `project_summary`).

### 4. What remains in Rust

ffmpeg derivative jobs, the audio mixer, export, probe, cloud
(transcribe/synthesize), and the `weftcut-eval` leaf — all stateless,
request/response, in-process.

## Testing & safety

- **Per-method slice tests**: each converted napi method asserts "given the
  slice → result identical to the pre-change mirror-backed result."
- **Import rework**: reuse the existing import / conform / proxy e2e gates; add
  a regression proving derivatives land at the real-hash cache key with no
  `pending-` artifact (the pending keyspace should no longer appear on disk).
- **MCP resource parity**: assert the TS-served `project://current` /
  `project://history` are canonical-identical to the old Rust-served output
  (reuse `canonical.ts`).
- Each phase ends green on `cargo test --features export,mcp,cloud`, `tsc -b`,
  and the vitest suite.

## Sequencing (each phase independently mergeable)

1. **Single-media read channels**: the four `commands/media.rs` channels
   (`ensure_conform`, `ensure_full_proxy`, `get_media_thumbnail`,
   `get_waveform_peaks`) take a `MediaItem` argument and drop their
   `snapshot_for_read` call. (The jobs they enqueue still re-read via
   `fresh_media_item` until phase 4 — the mirror handle on the jobs path is
   removed there, since dropping it requires the hash-first guarantee.)
2. **Broad-state compute**: export audio calls take the full project; `detect_silences`
   / `transcribe_clip` take their layer+media slice.
3. **MCP resources**: `project://current` / `project://history` served by the TS
   MCP host.
4. **Import rework (variant B)**: hash-first enqueue — jobs bake the real-hash
   `MediaItem`, dropping the mirror handle on the enqueue/jobs path and
   `fresh_media_item`; delete `pending_hash_for`, the `migrate_hash_artifacts`
   call, `patch_derivative_paths_after_hash_migration`, and `rewrite_hash_in_path`.
5. **Delete the mirror**: remove `read_mirror` + `set_project_mirror` +
   `snapshot_for_read` + `ReadMirror` + `mirror_history_view`, and the
   per-commit push.

## Non-goals

- No separate OS process for Rust (ADR 0024 stands).
- No new slice DTOs — reuse `MediaItem` / `Project` serialization.
- No change to the renderer-facing `project:changed` event or
  `project_summary` pull.
- The lazy-deserialize / compact-JSON perf optimizations are a separate,
  smaller change, not part of this design.

## Risks

- **Import rework is the heaviest, highest-risk phase**: the provisional-hash
  model nuance and the extra source read. It is sequenced last-but-one and
  gated by its own e2e regression.
- **MCP resource parity**: TS-served `project://current` must match what agents
  already consume; the canonical-parity test is the guard.
