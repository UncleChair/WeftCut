# State-actor TS migration — Phase 3c-i design

**Date:** 2026-06-23
**Slice:** 3c-i — complete the TS actor's media-pool command surface (corpus-gated)
**Status:** design approved; pending implementation plan

## Context

Phase 3c is the **authority flip**: making the TS state actor (in Electron main) the
single source of truth, replacing the Rust actor. It is split into two slices:

- **3c-i (this doc)** — port the remaining media-pool *mutations* into the TS actor,
  gated against the Rust oracle with the proven Phase-2b differential machinery. **No
  live wiring.** After this slice the TS actor can *hold* every media-pool state that
  Rust import/jobs/MCP produce.
- **3c-ii (separate brainstorm)** — the live cutover: `backend:invoke` routing,
  persistence re-home, autosave port, and the Rust→TS import/jobs write-back wiring.

Today four write paths all mutate the **Rust** actor, whose `subscribe()` feeds the UI
bridge, autosave, and MCP. The category-A commands (the ~38 `SUPPORTED_OPS`) plus
`add_media_item` and `replace_state` are already ported to the TS actor. The media-pool
mutations below are the remaining Rust→state write paths.

## Scope

Port **three** mutations; defer one.

| Mutation | Rust (`state/actor.rs`) | Why in 3c-i |
|---|---|---|
| `set_media_derivatives` | `do_set_media_derivatives` (≈3534) | Strictly blocks 3c-ii (jobs write-back) |
| `set_media_workspace_paths` | `do_set_media_workspace_paths` (≈3500) | Strictly blocks 3c-ii (import write-back) |
| `remove_media` | `do_remove_media` (3428) | Same machinery; completes the media-pool surface; gives the cascade real corpus coverage so 3d (MCP) need not revisit the actor |

**Deferred, explicitly:**

- `add_transient_track` — **zero production call sites** (the docstring claiming
  `import_media` uses it is stale; import uses `add_track(transient:false)`). Trivial to
  add later if a recording/transient-track feature needs it. The model already carries
  `Track.transient`, so loaded `.vproj` files with transient tracks round-trip regardless.
- `rebind_motif` + Motif `update_layer_params` content-window clamp — motif-catalog-blocked;
  ride with 3d / tooling work.
- All live wiring (`backend:invoke` routing, persistence re-home, autosave port,
  import/jobs write-back) → **3c-ii**.
- MCP handler re-point (the `remove_media` tool's only consumer) → **3d**.

## Model / errors — no changes

Verified clean (this is the slice's main fidelity risk; the 2b-v `label` field-drift bug
proves `MediaItem` drift is real):

- TS `MediaItem` (`apps/desktop/src/main/state/model.ts:86-91`) already carries every field
  these mutations touch: `label`, `path_abs`, `path_rel`, `kind`, `file_hash_blake3`,
  `file_size`, `file_mtime`, `imported_at`, `proxy_path`, `quick_proxy_path`,
  `proxy_bypassed`, `export_uses_original`, `proxy_format_version`, `conform_path`,
  `waveform_path`, `thumbnails_dir`.
- `errors.ts:35-36` already has `MediaNotFound { media }` and
  `MediaInUse { media; referenced_by }`.
- No `validate.ts` changes (the existing invariant suite covers the resulting states).

## Components (files touched)

- **`mutations/media.ts`** (exists, 2b-v) — three pure helpers:
  - `applySetMediaDerivatives(pool, id, patch)` → new pool with the patched item.
  - `applySetMediaWorkspacePaths(pool, id, paths)` → new pool with the patched item.
  - `computeRemoveMedia(project, id, force)` → discriminated result: either
    `{ kind: 'pool', pool }` (unrecorded path) or
    `{ kind: 'cascade', layersToDelete, pool }` (recorded force path), or throws the
    appropriate `CommandError`.
- **`actor.ts`** — three dedicated closures (mirroring the 2b-vi `updateTrackFlags`
  pattern) + three `dispatch` arms:
  - `set_media_derivatives` / `set_media_workspace_paths` →
    `history.replaceMediaPoolEverywhere(newPool)` + `broadcastUnrecorded`.
  - `remove_media` branches internally: unused → `replaceMediaPoolEverywhere` +
    `broadcastUnrecorded`; force-cascade → `commit` (raw inline layer removal in the recipe).
- **`replay.ts`** — add the three ops to `SUPPORTED_OPS` and `buildArgs` cases
  (tri-state derivative patch; media-id literal resolution).
- **`native/src/bin/replay_driver.rs`** — three `apply()` arms: build
  `MediaDerivativesPatch` with the tri-state mapping, the five workspace scalars, and
  `remove_media(id, force)`.
- **Corpus + oracles** — new seqs in `fixtures/state-corpus/`, additively regenerated
  (state + summary oracles), **zero pre-existing oracles modified**.
- **Gates** — `__tests__/differential.phase2.test.ts`, `summary.differential.test.ts`,
  `persistence.differential.test.ts` re-run on the expanded corpus (`skipped===[]`); unit
  tests in `media.test.ts`.

## Per-mutation semantics & id-contracts

`broadcastUnrecorded` mints exactly **1** id (`actor.ts:94`); `commit` mints **1** op_id
**after** validate passes (`actor.ts:84`) — a failed validate or an early reject burns **0**.

| Mutation | Path | Reject order (0 ids) | Success id burn | Undoable |
|---|---|---|---|---|
| `set_media_derivatives` | UNRECORDED | `MediaNotFound` | 1 (broadcast) | no |
| `set_media_workspace_paths` | UNRECORDED | `MediaNotFound` | 1 (broadcast) | no |
| `remove_media` unused | UNRECORDED (durable across undo) | `MediaNotFound` → probe `ValidationError` | 1 (broadcast) | no |
| `remove_media` in-use, `!force` | — | `MediaNotFound` → `MediaInUse{referenced_by}` | 0 | — |
| `remove_media` in-use, `force` | RECORDED cascade | `MediaNotFound` → commit `ValidationError` | 1 (op_id) | yes |

`do_remove_media` (actor.rs:3428) reference set = layers whose params are
`VideoClip`/`Audio`/`ImageOverlay` with `media == id`.

## Keystone landmines (the differential gate locks these)

1. **Tri-state derivative patch.** `MediaDerivativesPatch.proxy_path` /
   `quick_proxy_path` are Rust `Option<Option<PathBuf>>`. The remaining patch fields
   (`proxy_format_version`, `proxy_bypassed`, `export_uses_original`, `waveform_path`,
   `conform_path`, `thumbnails_dir`) are plain `Option<T>` (present-or-leave). JSON
   convention for the patch object: **key absent = leave, `null` = clear, string = set**.
   TS apply keys off `'proxy_path' in patch` (hasOwnProperty) — **never** `!== undefined`,
   which cannot distinguish absent from `null`. The Rust driver arm mirrors it:
   `None` (omitted) / `Some(None)` (null) / `Some(Some(p))` (string). Corpus drives all
   three states for both tri-state fields.
2. **`remove_media` force-cascade is a RAW inline layer delete.** `do_remove_media`
   (actor.rs:3479-3488) removes each referencing layer with a bare
   `track.layers.remove(idx)` — it does **not** call `do_delete_layer`, so there is **no
   empty-track auto-prune and no group-membership cleanup**. The TS port must build the
   cascade by raw layer removal in the `commit` recipe and must **not** reuse
   `applyDeleteLayer`. Corpus includes a force-cascade that leaves an empty track behind
   to prove no prune occurs.
3. **HYBRID undoability.** The two patches and the unused-remove are **not undoable**
   (unrecorded — durable across undo via `replaceMediaPoolEverywhere`); the force-cascade
   **is** undoable (undo restores the deleted layers + media). Corpus includes `undo`
   steps after each branch to lock the difference.
4. **Validate-before-broadcast on unused-remove.** `do_remove_media` validates the probe
   pool (actor.rs:3470) *before* broadcasting, so a `ValidationError` is possible even on
   an unused remove and burns 0 ids. The TS port validates before `broadcastUnrecorded`.

## Corpus coverage (new sequences)

Every success seq ends with a trailing `add_track` whose minted id reveals `base+N`,
proving the id-burn count.

- `set-media-derivatives-set` / `-clear` / `-leave` — tri-state for both proxy fields (+1 each).
- `set-media-derivatives-missing-media` — `MediaNotFound` (+0).
- `set-media-workspace-paths` (+1) and `-missing-media` (+0).
- `remove-media-unused` — +1 broadcast; trailing `undo` proves the media stays removed.
- `remove-media-in-use-no-force` — `MediaInUse` (+0).
- `remove-media-force-cascade` — referencing layers gone, +1 op_id; trailing `undo`
  restores layers + media.
- `remove-media-force-leaves-empty-track` — proves no auto-prune.
- `remove-media-missing` — `MediaNotFound` (+0).

## Oracle regeneration toolchain (verified working, 2b)

`replay_driver` build env: `FFMPEG_DIR=<Gyan.FFmpeg.Shared>/ffmpeg-8.1.1-full_build-shared`,
`LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH += $FFMPEG_DIR/bin`; build with
`--features replay,jobs,export,mcp,cloud,motifs`. Then
`node scripts/gen-state-oracle.mjs` regenerates the corpus (state + summary oracles).
Regen must be **additive**: confirm the existing oracles are byte-identical
(`git diff --diff-filter=M` over `fixtures/state-corpus/` = ∅) and only new files appear.

## Exit gates

- `differential.phase2.test.ts` — full state corpus, `skipped===[]`, per-step canonical
  state + `ok` + error-variant identical to the Rust oracle.
- `summary.differential.test.ts` — full corpus summary view identical.
- `persistence.differential.test.ts` — each oracle's final Rust-serialized state
  round-trips through `loadProjectFromJson`→`serializeProject` canonical-equal.
- `media.test.ts` unit tests for the tri-state apply and the cascade plan.
- Full state suite green; `tsc` clean.

## Carry-forwards into 3c-ii / 3d

- 3c-ii consumes `setMediaDerivatives` / `setMediaWorkspacePaths` (import/jobs Rust→TS
  write-back) and the already-built `add_media_item` / `replace_state`.
- 3d consumes `remove_media` (the MCP `remove_media` tool re-point).
- `parseProject` is still a bare `as Project` cast (Phase-1 carry-forward (a)); the
  persistence round-trip gate catches field-NAME drift but not an undeclared *new* Rust
  field. Structural validation is added when 3c-ii wires real `.vproj` reads.
