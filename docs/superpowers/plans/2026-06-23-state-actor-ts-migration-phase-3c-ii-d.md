# State-actor TS migration — Phase 3c-ii-d (THE FLIP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TypeScript state actor authoritative for the renderer/main-process path behind one launch flag `WEFTCUT_TS_ACTOR` (default off), replacing the Rust actor as the single writer, with the Rust actor kept as a fallback until Phase 4.

**Architecture:** A flag-gated splitter at `src/main/index.ts`'s `backend:invoke` handler routes the renderer's category-A state commands to the TS production adapter (`actor.command`), reads (`project_summary`/`get_project_settings`) to the gated TS read views, and persistence/save to the 3c-ii-b orchestrator + 3c-ii-c autosave; everything else (media/jobs/export/motif-authoring/cloud/recents/keybindings/app-settings/view-state/export-settings/logs/agent-session) keeps forwarding to Rust. The TS actor's `subscribe` stream drives `evt:project:changed` + `mcp:change` with the Rust-identical payload shape. Jobs derivative write-back arrives as a `media:derivatives` event applied to the TS actor. Two renderer-reachable category-A channels with no TS path (`add_motif`, `project_restore_checkpoint`) are rejected under the flag and deferred to 3d.

**Tech Stack:** TypeScript (Electron main, ESM, `node:fs`/`node:path`), Immer-based TS actor, napi-rs `@weftcut/core` addon (Rust), Vitest (unit + differential gates), Playwright `_electron` (e2e), the `prod_driver` det-id oracle + `gen-state-oracle.mjs` regen toolchain.

## Global Constraints

- **One flag, default off:** `WEFTCUT_TS_ACTOR` (read as `process.env['WEFTCUT_TS_ACTOR'] === '1'`). Flag off ⇒ today's behavior byte-for-byte (everything forwards to `backend.invoke`); the new TS-actor path is dormant. The flip is atomic — when on, mutations, reads, persistence, autosave, jobs-write-back, and MCP-pause all switch together (spec F2).
- **Single writer when on:** no category-A *state* mutation or read may route to the now-stale Rust actor while the flag is on. Any renderer category-A channel the TS adapter cannot serve is *rejected* (never forwarded to Rust) to preserve the single-writer invariant.
- **Production ids/clock:** the production TS actor uses `uuidV7Gen()` (real time-ordered UUIDs) + a real clock `() => new Date().toISOString()`. Det mode (`seededGen`) is ONLY for the oracle harness, never production.
- **Gated core is sacred:** reuse `actor.command`/`commit`/`runValidate`/the closures/`apply*`. Do NOT re-implement mutations. `dispatch()`'s **mutation semantics** stay unchanged — it guards 175 state + 174 summary + 35 prod oracles, all of which must regen byte-identical. The ONLY permitted `dispatch()` edit in this slice is threading an additive optional `with_audio` seed flag through the `add_media` arm (defaults `false` ⇒ every existing seq, which omits it, regenerates byte-identical). The state/summary `buildArgs` path (`replay.ts:136`) is NOT touched — only `replayProductionSequence`'s explicit `add_media` seed (`replay.ts:197`).
- **Differential discipline:** the auto-pair gate (Task 1) is the only new corpus dimension change; regen is ADDITIVE — existing 175 state + 174 summary + 35 prod oracles must remain byte-identical (`git diff --diff-filter=M fixtures/state-corpus` = ∅ for pre-existing files). Per-step canonical state + `ok` + error-variant identical; `skipped===[]`.
- **Evergreen docs:** this plan is dated; design docs (`docs/data-model.md` etc.) and the corpus README are not — no phase numbers / commit hashes in them ([[feedback_evergreen_docs]]).
- **AudioRole wire form is kebab** (`'music'`, `'dialogue'`) — `#[serde(rename_all="kebab-case")]` (audio_role.rs:14).
- **napi bindings (`native/index.d.ts`) are gitignored** — regenerated on disk, never committed; Task 2 regenerates them in this env (3c-ii-b carry-forward (a)).
- **Build/regen env (controller-run; PowerShell):** the `prod_driver` build + `gen-state-oracle.mjs` regen + `napi:build` need (per the prior-slice recipe / `reference_ffmpeg_next_windows_setup.md`):
  - `$env:FFMPEG_DIR` = the `Gyan.FFmpeg.Shared` `ffmpeg-8.1.1-full_build-shared` dir
  - `$env:LIBCLANG_PATH` = `C:\Program Files\LLVM\bin`
  - `$env:PATH` = `"$env:FFMPEG_DIR\bin;$env:PATH"`
  - cargo features for the bins: `--features replay,jobs,export,mcp,cloud,motifs`

---

## Findings recap (verified against code, 2026-06-23)

**Splitter classification — every distinct renderer-sent `backend:invoke` channel:**

| Route (flag on) | Channels |
|---|---|
| **TS — `actor.command(channel, args)`** (31 PRODUCTION_OPS) | `add_track`, `add_color_layer`, `add_text_layer`, `add_media_layer`, `add_demo_color_layer`, `add_demo_text_layer`, `update_layer`, `update_layer_params`, `update_layer_param_track`, `update_layer_param_tracks`, `add_effect`, `update_effect`, `move_effect`, `remove_effect`, `move_layer`, `trim_layer`, `delete_layer`, `duplicate_layer`, `split_layer_grouped`, `separate_audio_to_new_track`, `groups_create`, `groups_dissolve`, `set_composition`, `fit_composition_to_layers`, `update_track_flags`, `set_role_gain`, `update_role_flags`, `update_project_settings`, `restyle_caption_track`, `project_undo`, `project_redo` |
| **TS — `buildProjectSummary`** | `project_summary` |
| **TS — `actor.snapshot().settings`** | `get_project_settings` |
| **TS — orchestrator / autosave** | `project_open`, `project_save_as`, `project_new_workspace`, `project_save` |
| **REJECT under flag (deferred to 3d)** | `add_motif`, `project_restore_checkpoint` |
| **Rust — `backend.invoke` (unchanged)** | `ping`, `workspace_dir`, `app_settings_get/set`, `view_state_get/set`, `export_settings_get/set`, `recents_*`, `keybindings_*`, `agent_session_get/end`, `log_*`, `import_*`, `ensure_*`, `get_media_thumbnail`, `get_waveform_peaks`, `report_audio_meter`, `export_*`, `mux_export`, `settings_*_api_key`, `settings_get_api_key_status`, `settings_test_provider`, `list_motifs`, `get_motif_source`, `write_motif_draft`, `install_motif`, `delete_motif`, `amend_motif_draft`, `create_edit_draft`, `import_motif`, `motif_staleness_report`, `acknowledge_motif_staleness`. (Plus the existing main-only intercepts already above the dispatch: `motif_register_runtime`, `motif_capture_frame`, `settings_set_api_key`, `settings_clear_api_key`.) |

- Only `get_project_settings`/`update_project_settings` touch `project.settings`; `project_summary`'s data source is the actor snapshot (→ TS). All other prefs/stores (app_settings, view_state, export_settings, recents, keybindings, logs, agent_session) are independent of the migrated `Project` and stay on Rust.
- **⚠️ CORRECTION (2026-06-24 audit):** the "Rust — unchanged" row above is WRONG for a subset that this bullet wrongly called "independent of the migrated Project." `import_media`, `ensure_full_proxy`, `ensure_conform`, `get_media_thumbnail`, `get_waveform_peaks`, `export_project_audio_only`, `ensure_export_audio_conform`, `install_motif` (update-mode `rebind_motif`), `motif_staleness_report`, `acknowledge_motif_staleness` actually **read/write the project actor** (`commands/export.rs:34`, `commands/media.rs:25/88/143/155/168/176/190`, `commands/motif_authoring.rs:46`→`motifs/authoring_commands.rs:255`, `napi_backend.rs:812/814`) → stale/blank under the flag, violating the line-14 single-writer invariant. (The "pure motif-store" set narrows to `list_motifs`/`get_motif_source`/`write_motif_draft`/`amend_motif_draft`/`create_edit_draft`/`import_motif`/`delete_motif`.) These are NOT fixed by 3d; tracked as **Phase 3d-e** (native-compute input re-point) in `specs/2026-06-24-state-actor-phase-3d-design.md` and MUST land before `WEFTCUT_TS_ACTOR` goes default-on.
- `agent_session_end` calls Rust `handle.unlock_history()` — but during the soak no agent session is created (D6 pauses MCP), so the TS history is never locked and the Rust unlock is inert. Deferred to 3d.
- The 11 channels `add_marker`/`update_marker`/`remove_marker`/`delete_track`/`move_track`/`groups_add_members`/`groups_remove_members`/`groups_rename`/`add_transition`/`remove_transition`/`add_caption_track` are confirmed **renderer-unreachable** (MCP-only) → they cannot arrive on `backend:invoke`; D6 pauses them on the MCP side.

**Auto-pair (the hard-gate prerequisite, `mutations.rs:146-180`):** when `media.kind==Video` AND `media.metadata.audio.is_some()` AND `settings.auto_pair_audio_on_import` (default `true` both engines), `add_media_layer` does THREE actor calls: (1) add the Video layer, (2) add an Audio layer (`role=Dialogue`/wire `'dialogue'`, same media/src/span, **same track**), (3) `groups_create([video_id, audio_id], None, false)`; returns the video id. Currently unreachable only because every corpus media template hard-codes `audio:null`.

---

## File structure

- `apps/desktop/src/main/state/commands.ts` (modify) — extend `prodMediaLayer` to surface the auto-pair audio params.
- `apps/desktop/src/main/state/actor.ts` (modify) — `add_media_layer` command arm does the 3-commit auto-pair fan-out.
- `apps/desktop/src/main/state/mutations/media.ts` (modify) — `mediaItemTemplate` gains an optional `withAudio` to seed audio metadata.
- `apps/desktop/native/src/bin/prod_driver.rs` (modify) — `media_item()` reads a `with_audio` flag → `audio: Some(default)`.
- `apps/desktop/fixtures/state-corpus/sequences-prod/*.json` (create) — auto-pair seqs + controls.
- `apps/desktop/src/main/state/router.ts` (create) — pure `routeChannel(channel)` classification + the routed-channel sets.
- `apps/desktop/src/main/state/router.test.ts` (create) — classification unit tests.
- `apps/desktop/src/main/state/ts-actor-host.ts` (create) — construct + own the production TS actor, the autosave controller, the WorkspaceNapi/Fs adapters, and the event-bridge mapper; one factory `createTsActorHost(backend, send, mcpNotify)` consumed by `index.ts`.
- `apps/desktop/src/main/state/ts-actor-host.test.ts` (create) — event-payload mapping + route-dispatch unit tests.
- `apps/desktop/src/main/index.ts` (modify) — flag-gated splitter in `backend:invoke`; construct the host at boot; route `media:derivatives` in `onEvent`.
- `apps/desktop/src/main/mcp/server.ts` (modify) — D6: reject category-A mutation tools under the flag.
- `apps/desktop/src/main/mcp/mutationTools.ts` (create) — the category-A MCP mutation tool-name denylist + `isPausedUnderTsActor(name)`.
- `apps/desktop/src/main/mcp/mutationTools.test.ts` (create) — denylist gate test.
- `apps/desktop/native/src/state/actor.rs` (modify) — `#[serial]`-serialize the two `TS_DERIVATIVE_AUTHORITY` toggle tests (pre-flip checklist).
- `apps/desktop/e2e/specs/ts-actor-flip.e2e.js` (create) — flag-on `_electron` round-trip (controller-run).
- `apps/desktop/fixtures/state-corpus/README.md` (modify) — auto-pair seqs; flip notes.

---

### Task 1: `add_media_layer` auto-pair + production differential gate

**Files:**
- Modify: `apps/desktop/src/main/state/commands.ts`
- Modify: `apps/desktop/src/main/state/actor.ts:454-464` (the `add_media_layer` command arm)
- Modify: `apps/desktop/src/main/state/mutations/media.ts:32-40` (`mediaItemTemplate`)
- Modify: `apps/desktop/src/main/state/replay.ts:197` (`replayProductionSequence`'s `add_media` seed — pass `with_audio`)
- Modify: `apps/desktop/native/src/bin/prod_driver.rs:141-157` (`media_item`)
- Create: `apps/desktop/fixtures/state-corpus/sequences-prod/add-media-layer-auto-pairs.json`
- Create: `apps/desktop/fixtures/state-corpus/sequences-prod/add-media-layer-no-audio-no-pair.json`
- Create: `apps/desktop/fixtures/state-corpus/sequences-prod/add-media-layer-pair-setting-off.json`
- Test: `apps/desktop/src/main/state/__tests__/commands.differential.test.ts` (existing gate; picks up new seqs)
- Test: `apps/desktop/src/main/state/commands.test.ts` (existing unit file; add an auto-pair shape unit test)

**Interfaces:**
- Consumes: `videoClipParams`/`audioParams` (`mutations/media.ts`), `applyAddLayer`/`applyGroupsCreate`, `commit`, `prodMediaLayer`.
- Produces: `prodMediaLayer(a, project)` now returns `{ params: LayerParams; durationUs: number; autoPairAudio: LayerParams | null }`; `mediaItemTemplate(id, kind, durationUs, withAudio?: boolean)`.

- [ ] **Step 1: Write the failing differential corpus seq.** Create `sequences-prod/add-media-layer-auto-pairs.json`:

```json
{
  "name": "add-media-layer-auto-pairs",
  "commands": [
    { "op": "add_media", "id": "11111111-1111-1111-1111-111111111111", "kind": "Video", "duration_us": 4000000, "with_audio": true, "ref": "m" },
    { "op": "add_media_layer", "trackId": "@A", "mediaId": "@m", "tStartUs": 0, "ref": "vid" },
    { "op": "add_text_layer", "tStartUs": 0 }
  ]
}
```

(The trailing `add_text_layer` pins the id counter: after a 3-commit auto-pair its layer id reveals base+N, catching any missing/extra id allocation.)

- [ ] **Step 2: Write the no-pair control seqs.** `add-media-layer-no-audio-no-pair.json` (same but `"with_audio": false` ⇒ single commit, no pair) and `add-media-layer-pair-setting-off.json` (`with_audio: true`, but precede with `{ "op": "update_project_settings", "patch": { "auto_delete_empty_tracks": null } }` is NOT enough — instead add a leading `{ "op": "update_project_settings", "patch": { "auto_pair_audio_on_import": false } }`). Verify `ProjectSettingsPatch` carries `auto_pair_audio_on_import` (model.ts + Rust `ProjectSettingsPatch`); if `update_project_settings` does not expose it, drop this third seq and note in the README that the setting-off path is unit-tested only.

- [ ] **Step 3: Extend the Rust driver `media_item` to honor `with_audio`.** In `prod_driver.rs`, replace the `metadata` line so an audio block is attached when requested:

```rust
metadata: MediaMetadata {
    duration_us: cmd["duration_us"].as_i64(),
    video: None,
    audio: if cmd["with_audio"].as_bool().unwrap_or(false) {
        Some(state::media::AudioMetadata::default())
    } else { None },
    container_format: None,
},
```

Verify `state::media::AudioMetadata` has a `Default` (or build the minimal literal the type requires); the exact fields don't matter to auto-pair (the predicate is only `audio.is_some()`), but they MUST serialize identically to the TS twin (Step 4).

- [ ] **Step 4: Extend the TS `mediaItemTemplate` twin.** In `mutations/media.ts`, add `withAudio` and mirror the Rust audio block byte-for-byte:

```typescript
export function mediaItemTemplate(id: Uuid, kind: MediaItem['kind'], durationUs: number | null, withAudio = false): MediaItem {
  return {
    id, label: null, path_abs: 'media/clip.bin', path_rel: null, kind,
    metadata: { duration_us: durationUs, video: null,
      audio: withAudio ? { /* mirror AudioMetadata::default() serialization exactly */ } : null,
      container_format: null },
    file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '2026-01-01T00:00:00Z',
    proxy_path: null, quick_proxy_path: null, proxy_bypassed: false, export_uses_original: false,
    proxy_format_version: 0, conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
}
```

Read `native/src/state/media.rs` for `AudioMetadata`'s fields + their serde defaults and write the exact JSON object the differential canonicalize will compare. Then thread the flag through the two TS seed points (additive — `Cmd` already types extra keys as `unknown`):
- `add_media` dispatch arm (`actor.ts:372`): `addMediaItem(mediaItemTemplate(a.id as Uuid, a.kind as MediaItem['kind'], (a.duration_us as number | null) ?? null, (a.with_audio as boolean | undefined) ?? false))`.
- `replayProductionSequence` (`replay.ts:197`): `actor.dispatch('add_media', { id: cmd.id, kind: cmd.kind, duration_us: cmd.duration_us ?? null, with_audio: cmd.with_audio ?? false })`.

Do NOT touch `buildArgs`'s `add_media` case (`replay.ts:136`) — the state/summary corpus must stay byte-identical.

- [ ] **Step 5: Surface the auto-pair from `prodMediaLayer`.** In `commands.ts`, change the Video arm + return type:

```typescript
export interface MediaLayerResult {
  params: LayerParams
  durationUs: number
  /** When the source is a video carrying audio AND auto_pair_audio_on_import is on,
   *  the paired Audio layer params (role=dialogue). Else null. mutations.rs:146-180. */
  autoPairAudio: LayerParams | null
}

export function prodMediaLayer(a: Record<string, unknown>, project: Project): MediaLayerResult {
  const mediaId = a.mediaId as string
  const item = project.media_pool[mediaId]
  if (!item) throw new Error(`media not found in pool: ${mediaId}`)
  const totalSrc = (item.metadata.duration_us as number | null | undefined) ?? 2_000_000
  switch (item.kind) {
    case 'Video': {
      const autoPair = item.metadata.audio != null && project.settings.auto_pair_audio_on_import
        ? { ...audioParams(mediaId, 0, totalSrc), role: 'dialogue' as const }
        : null
      return { params: videoClipParams(mediaId, 0, totalSrc), durationUs: totalSrc, autoPairAudio: autoPair }
    }
    case 'Audio':
      return { params: audioParams(mediaId, 0, totalSrc), durationUs: totalSrc, autoPairAudio: null }
    case 'Image': {
      const span = imageLayerSpanUs(item.metadata as { duration_us: number | null; video?: { nb_frames?: number | null } | null })
      return { params: imageOverlayParams(mediaId), durationUs: span, autoPairAudio: null }
    }
    default:
      throw new Error(`unsupported media kind for add_media_layer: ${item.kind}`)
  }
}
```

(`audioParams` returns a `LayerParams` union; `{ ...audioParams(...), role: 'dialogue' }` overrides the `'music'` default. If TS narrowing complains, cast through the `Audio` arm.)

- [ ] **Step 6: Do the 3-commit fan-out in the `add_media_layer` command arm.** Replace `actor.ts:454-464`:

```typescript
case 'add_media_layer': {
  const trackId = wireArgs.trackId as string
  const t0 = wireArgs.tStartUs as number
  const { params, durationUs, autoPairAudio } = prodMediaLayer(wireArgs, current())
  const t1 = t0 + durationUs
  const videoId = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
    applyAddLayer(d, idGen, trackId, params, t0, t1))
  if (autoPairAudio !== null) {
    // mutations.rs:161-179: paired Audio layer (role dialogue) on the SAME track,
    // same span, then groups_create([video, audio]). THREE separate commits ⇒ three
    // op_ids, matching Rust's three handle calls (the id-allocation keystone).
    const audioId = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
      applyAddLayer(d, idGen, trackId, autoPairAudio, t0, t1))
    commit('Created group', [], { kind: 'Coarse' }, (d) =>
      applyGroupsCreate(d, idGen, [videoId, audioId], null, false))
  }
  return { ok: true, value: videoId }
}
```

- [ ] **Step 7: Add a unit test for the auto-pair shape.** In `commands.test.ts`, build a det actor, seed a Video media item with audio metadata, `command('add_media_layer', { trackId, mediaId, tStartUs: 0 })`, then assert on `actor.snapshot()`: the target track has a Video and an Audio (role `'dialogue'`) layer at the same span, and exactly one group contains both layer ids.

- [ ] **Step 8: Regen the prod oracles (CONTROLLER, build env).** Run (PowerShell, env set per Global Constraints):

```
node scripts/gen-state-oracle.mjs
```

Expected: 3 new files in `oracle-prod/` (one per new seq); `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` is EMPTY (no pre-existing oracle modified — additive only).

- [ ] **Step 9: Run the differential gate + unit + tsc.**

Run: `npm --prefix apps/desktop run test -- commands.differential commands.test`
Expected: PASS, `skipped===[]`, the auto-pair seq + controls byte-identical to the oracle.
Run: `npm --prefix apps/desktop run typecheck` (or `tsc -b`) — Expected: clean.

- [ ] **Step 10: Commit.**

```bash
git add apps/desktop/src/main/state/commands.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mutations/media.ts apps/desktop/src/main/state/replay.ts apps/desktop/native/src/bin/prod_driver.rs apps/desktop/fixtures/state-corpus apps/desktop/src/main/state/commands.test.ts
git commit -m "feat(state-migration): add_media_layer auto-pair + prod-differential gate (Phase 3c-ii-d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Regenerate napi bindings + verify the addon exports the 3c-ii-b/c methods

**Files:**
- Regenerate (on disk, gitignored): `apps/desktop/native/index.d.ts`, the platform `.node` addon.

**Interfaces:**
- Produces: a built `@weftcut/core` whose `Backend` type + runtime expose `commitWorkspace(path): Promise<void>`, `pushRecent(path, displayName): void`, `setLastNewProjectParent(parent): void`, `enqueueJobsForMedia(mediaItemsJson): Promise<void>`, and `setTsDerivativeAuthority(on: boolean): void` (verify the exact exported name of the 3c-ii-c authority setter — Rust `pub fn set_ts_derivative_authority`).

- [ ] **Step 1: Build the addon (CONTROLLER, build env).** From `apps/desktop`:

```
npm run napi:build      # or the project's documented native build (see reference_worktree_bootstrap.md: build:wasm + napi:build)
```

Expected: `native/index.d.ts` regenerated; exit 0.

- [ ] **Step 2: Confirm the new methods are in the regenerated `.d.ts`.**

Run (Grep, not committed): search `native/index.d.ts` for `commitWorkspace`, `pushRecent`, `setLastNewProjectParent`, `enqueueJobsForMedia`, and the derivative-authority setter.
Expected: all present. If the authority setter is NOT `#[napi]`-exported (3c-ii-c added it as `pub fn` for Rust callers only), add a thin `#[napi] pub fn set_ts_derivative_authority(&self, on: bool)` wrapper in `napi_backend.rs` that calls `crate::state::set_ts_derivative_authority(on)`, rebuild, and re-verify. Commit that Rust wrapper.

- [ ] **Step 3: Runtime smoke (CONTROLLER).**

```
node -e "const {Backend}=require('./native'); const b=new Backend(process.cwd(),process.cwd(),()=>{}); console.log(['commitWorkspace','pushRecent','setLastNewProjectParent','enqueueJobsForMedia','setTsDerivativeAuthority'].map(m=>m+':'+(typeof b[m])).join(' '))"
```

Expected: each method prints `:function`.

- [ ] **Step 4: Commit (only if a Rust napi wrapper was added in Step 2).**

```bash
git add apps/desktop/native/src/napi_backend.rs
git commit -m "feat(state-migration): expose set_ts_derivative_authority over napi (Phase 3c-ii-d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(If no Rust change was needed, this task produces no commit — the regenerated `.d.ts` is gitignored. Record in the SDD ledger that the addon was rebuilt.)

---

### Task 3: Pure channel router + classification tests

**Files:**
- Create: `apps/desktop/src/main/state/router.ts`
- Test: `apps/desktop/src/main/state/router.test.ts`

**Interfaces:**
- Consumes: `PRODUCTION_OPS` (`commands.ts`).
- Produces:
  - `type Route = { kind: 'command' } | { kind: 'summary' } | { kind: 'projectSettings' } | { kind: 'open' } | { kind: 'saveAs' } | { kind: 'newWorkspace' } | { kind: 'save' } | { kind: 'reject'; reason: string } | { kind: 'rust' }`
  - `routeChannel(channel: string): Route`
  - `BLOCKED_UNDER_FLAG: ReadonlySet<string>` = `{'add_motif','project_restore_checkpoint'}`

- [ ] **Step 1: Write the failing classification test.** `router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { routeChannel } from './router'
import { PRODUCTION_OPS } from './commands'

describe('routeChannel', () => {
  it('routes every PRODUCTION_OPS channel to command', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).toBe('command')
  })
  it('routes reads + persistence + save to dedicated TS handlers', () => {
    expect(routeChannel('project_summary').kind).toBe('summary')
    expect(routeChannel('get_project_settings').kind).toBe('projectSettings')
    expect(routeChannel('project_open').kind).toBe('open')
    expect(routeChannel('project_save_as').kind).toBe('saveAs')
    expect(routeChannel('project_new_workspace').kind).toBe('newWorkspace')
    expect(routeChannel('project_save').kind).toBe('save')
  })
  it('rejects the two deferred renderer category-A channels', () => {
    expect(routeChannel('add_motif').kind).toBe('reject')
    expect(routeChannel('project_restore_checkpoint').kind).toBe('reject')
  })
  it('forwards independent stores + media/jobs/export to rust', () => {
    for (const ch of ['app_settings_get','app_settings_set','view_state_get','export_settings_get','recents_list','keybindings_get','agent_session_get','agent_session_end','log_list','import_media','ensure_full_proxy','export_video_sink_start','list_motifs','settings_test_provider','workspace_dir','ping'])
      expect(routeChannel(ch).kind).toBe('rust')
  })
  it('never routes a category-A state mutation to rust', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).not.toBe('rust')
  })
})
```

- [ ] **Step 2: Run it; verify it fails** (module not found).

Run: `npm --prefix apps/desktop run test -- router`
Expected: FAIL.

- [ ] **Step 3: Implement `router.ts`.**

```typescript
// apps/desktop/src/main/state/router.ts
// Pure splitter classification for the WEFTCUT_TS_ACTOR flip. Consulted by
// src/main/index.ts ONLY when the flag is on; flag-off = everything → rust.
// SAFETY INVARIANT (router.test.ts): no category-A state mutation routes to 'rust'.
import { PRODUCTION_OPS } from './commands'

export type Route =
  | { kind: 'command' }       // actor.command(channel, args)
  | { kind: 'summary' }       // buildProjectSummary
  | { kind: 'projectSettings' } // actor.snapshot().settings
  | { kind: 'open' } | { kind: 'saveAs' } | { kind: 'newWorkspace' } | { kind: 'save' }
  | { kind: 'reject'; reason: string }
  | { kind: 'rust' }

/** Renderer-reachable category-A mutations with NO TS path — rejected under the
 *  flag (single-writer), deferred to 3d. add_motif needs the motif catalog;
 *  project_restore_checkpoint has no TS command-surface create path (and no
 *  checkpoint can exist during a single-writer soak). */
export const BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set(['add_motif', 'project_restore_checkpoint'])

export function routeChannel(channel: string): Route {
  if (PRODUCTION_OPS.has(channel)) return { kind: 'command' }
  if (BLOCKED_UNDER_FLAG.has(channel)) return { kind: 'reject', reason: `${channel} is unavailable while the TS state actor is active (WEFTCUT_TS_ACTOR); ported in Phase 3d` }
  switch (channel) {
    case 'project_summary': return { kind: 'summary' }
    case 'get_project_settings': return { kind: 'projectSettings' }
    case 'project_open': return { kind: 'open' }
    case 'project_save_as': return { kind: 'saveAs' }
    case 'project_new_workspace': return { kind: 'newWorkspace' }
    case 'project_save': return { kind: 'save' }
    default: return { kind: 'rust' }
  }
}
```

- [ ] **Step 4: Run the tests; verify they pass.**

Run: `npm --prefix apps/desktop run test -- router`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts
git commit -m "feat(state-migration): pure backend:invoke channel router for the flip (Phase 3c-ii-d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: TS-actor host (actor bring-up + event bridge mapper) + splitter — mutations/reads

**Files:**
- Create: `apps/desktop/src/main/state/ts-actor-host.ts`
- Test: `apps/desktop/src/main/state/ts-actor-host.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (construct the host at boot; rewrite the `backend:invoke` body for the command/summary/projectSettings/reject routes)

**Interfaces:**
- Consumes: `createActor` (`actor.ts`), `uuidV7Gen` (`ids.ts`), `buildProjectSummary` (`summary.ts`), `routeChannel` (`router.ts`), `ActorHandle`/`ChangeEvent`.
- Produces:
  - `mapChangeEvent(e: ChangeEvent): { op_id: string; actor_kind: 'user'|'agent'; client: string | null; summary: string; timestamp: string; affected_count: number }` (the Rust `project:changed` payload shape, napi_backend.rs:155-165).
  - `createTsActorHost(deps): TsActorHost` with `{ actor: ActorHandle; handleInvoke(channel, args): Promise<unknown>; start(): void; stop(): void }` where `deps = { send(event,payload), mcpNotify(payload), fileExists(absPath): boolean, ...persistence deps deferred to Task 5 }`.

- [ ] **Step 1: Write the failing event-mapper test.** `ts-actor-host.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mapChangeEvent } from './ts-actor-host'

describe('mapChangeEvent', () => {
  it('maps a User ChangeEvent to the Rust project:changed payload shape', () => {
    const out = mapChangeEvent({ op_id: 'op-1', actor: { kind: 'User' }, timestamp: '2026-06-23T00:00:00.000Z', summary: 'Added layer', affected: [{ kind: 'Layer', id: 'L1' }], new_snapshot: {} as never, diff_hint: { kind: 'Coarse' } })
    expect(out).toEqual({ op_id: 'op-1', actor_kind: 'user', client: null, summary: 'Added layer', timestamp: '2026-06-23T00:00:00.000Z', affected_count: 1 })
  })
  it('maps an Agent ChangeEvent client through', () => {
    const out = mapChangeEvent({ op_id: 'op-2', actor: { kind: 'Agent', client: 'mcp' }, timestamp: 't', summary: 's', affected: [], new_snapshot: {} as never, diff_hint: { kind: 'Coarse' } })
    expect(out.actor_kind).toBe('agent'); expect(out.client).toBe('mcp')
  })
})
```

- [ ] **Step 2: Run it; verify it fails** (module not found).

Run: `npm --prefix apps/desktop run test -- ts-actor-host`
Expected: FAIL.

- [ ] **Step 3: Implement the host (mutation/read routes; persistence stubbed for Task 5).**

```typescript
// apps/desktop/src/main/state/ts-actor-host.ts
import { createActor, type ActorHandle, type ChangeEvent } from './actor'
import { uuidV7Gen } from './ids'
import { blankProject } from './model'
import { buildProjectSummary } from './summary'
import { routeChannel } from './router'

export interface TsActorHostDeps {
  /** mainWindow.webContents.send('evt:'+event, payload) */
  send: (event: string, payload: unknown) => void
  /** mcpHost.notifyChange(payload) — the mcp:change relay. */
  mcpNotify: (payload: unknown) => void
  /** fs.existsSync, for buildProjectSummary's media-availability checks. */
  fileExists: (absPath: string) => boolean
  // Task 5 injects: openProject/saveProjectAs/newWorkspace/save handlers + autosave.
  persistence?: PersistenceHandlers
}

export interface PersistenceHandlers {
  open: (dir: string) => Promise<void>
  saveAs: (dir: string) => Promise<void>
  newWorkspace: (args: { parentFolder: string; name: string; width: number; height: number; fpsNum: number; fpsDen: number }) => Promise<string>
  save: () => Promise<void>
}

export interface TsActorHost {
  actor: ActorHandle
  handleInvoke: (channel: string, args: Record<string, unknown>) => Promise<unknown>
  start: () => void
  stop: () => void
}

/** Rust project:changed payload shape (napi_backend.rs:155-165). */
export function mapChangeEvent(e: ChangeEvent): { op_id: string; actor_kind: 'user' | 'agent'; client: string | null; summary: string; timestamp: string; affected_count: number } {
  const actor_kind = e.actor.kind === 'Agent' ? 'agent' : 'user'
  const client = e.actor.kind === 'Agent' ? e.actor.client : null
  return { op_id: e.op_id, actor_kind, client, summary: e.summary, timestamp: e.timestamp, affected_count: e.affected.length }
}

export function createTsActorHost(deps: TsActorHostDeps): TsActorHost {
  const actor = createActor({ initial: blankProject(uuidV7Gen(), 'untitled'), idGen: uuidV7Gen(), clock: () => new Date().toISOString() })
  let unsub: (() => void) | null = null

  function emitChange(e: ChangeEvent): void {
    const payload = mapChangeEvent(e)
    deps.send('project:changed', payload)
    deps.mcpNotify(payload)
  }

  function reject(reason: string): never { throw new Error(reason) }

  async function handleInvoke(channel: string, args: Record<string, unknown>): Promise<unknown> {
    const route = routeChannel(channel)
    switch (route.kind) {
      case 'command': {
        const r = actor.command(channel, args)
        if (!r.ok) throw new Error(JSON.stringify(r.error)) // renderer maps the CommandError shape (parity with Rust string err)
        return r.value
      }
      case 'summary':
        return buildProjectSummary(actor.snapshot(), actor.historyStatus(), deps.fileExists)
      case 'projectSettings':
        return actor.snapshot().settings
      case 'open': return deps.persistence!.open((args as { path: string }).path)
      case 'saveAs': return deps.persistence!.saveAs((args as { path: string }).path)
      case 'newWorkspace': return deps.persistence!.newWorkspace(args as never)
      case 'save': return deps.persistence!.save()
      case 'reject': return reject(route.reason)
      case 'rust': return reject(`router bug: ${channel} reached the TS host but is a Rust channel`)
    }
  }

  return {
    actor,
    handleInvoke,
    start() { if (!unsub) unsub = actor.subscribe(emitChange) },
    stop() { if (unsub) { unsub(); unsub = null } },
  }
}
```

(Note: the `CommandError` → renderer error contract. Rust's `invoke` returns a string error; the renderer's `unwrapInvoke` throws `new Error(msg)`. Verify in `src/renderer/ipc/index.ts` how invoke errors surface and match the shape — if the renderer expects a specific error string for e.g. `MediaInUse`, serialize `r.error` the way the renderer parses. Adjust the `throw` in the `command` case accordingly; add a unit test if the contract is non-trivial.)

- [ ] **Step 4: Run the mapper test; verify it passes.**

Run: `npm --prefix apps/desktop run test -- ts-actor-host`
Expected: PASS.

- [ ] **Step 5: Wire the host into `index.ts` (mutations/reads only; persistence in Task 5).** Construct the host after `backend.init()`, gated on the flag, and consult it in `backend:invoke` BEFORE the `backend!.invoke` fallthrough. In `index.ts`:

```typescript
// after mcpHostRef is set:
const tsActorOn = process.env['WEFTCUT_TS_ACTOR'] === '1'
let tsHost: import('./state/ts-actor-host.js').TsActorHost | null = null
if (tsActorOn) {
  const { createTsActorHost } = await import('./state/ts-actor-host.js')
  tsHost = createTsActorHost({
    send: (event, payload) => mainWindow?.webContents.send('evt:' + event, payload),
    mcpNotify: (payload) => mcpHostRef?.notifyChange(payload),
    fileExists: (p) => fs.existsSync(p),
    // persistence injected in Task 5
  })
  tsHost.start()
  console.log('[main] WEFTCUT_TS_ACTOR on — TS state actor authoritative')
}
```

Then, in the `backend:invoke` handler, AFTER the existing main-only intercepts (`motif_register_runtime`, `motif_capture_frame`, `settings_set_api_key`, `settings_clear_api_key`) and BEFORE the `backend!.invoke` call, insert:

```typescript
if (tsHost) {
  const route = (await import('./state/router.js')).routeChannel(channel)
  if (route.kind !== 'rust') return await tsHost.handleInvoke(channel, (args ?? {}) as Record<string, unknown>)
}
```

(The router is consulted twice — once here to decide TS-vs-Rust, once inside `handleInvoke`. Acceptable; both are pure. Alternatively expose `tsHost.owns(channel): boolean`. Keep the existing `WEFTCUT_TS_ACTOR_SHADOW` dev-log block untouched.)

- [ ] **Step 6: Verify flag-off is unchanged + flag-on typechecks.**

Run: `npm --prefix apps/desktop run typecheck` — Expected: clean.
Run: `npm --prefix apps/desktop run test` — Expected: all existing suites green (flag default-off ⇒ the new path is dormant in unit tests).

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/state/ts-actor-host.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(state-migration): TS-actor host + backend:invoke splitter (mutations/reads) behind WEFTCUT_TS_ACTOR (Phase 3c-ii-d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Persistence + autosave + jobs write-back live wiring

**Files:**
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts` (add the persistence + autosave construction)
- Modify: `apps/desktop/src/main/state/autosave.ts:74-81` (wrap `takeSnapshot`'s `copyFile` in try/catch — pre-flip checklist (b))
- Modify: `apps/desktop/src/main/index.ts` (build the WorkspaceNapi/Fs adapters, inject persistence into the host, route `media:derivatives` in `onEvent`, set derivative authority)
- Test: `apps/desktop/src/main/state/ts-actor-host.test.ts` (add a persistence-route integration test with in-memory deps)

**Interfaces:**
- Consumes: `createAutosave` (`autosave.ts`), `openProject`/`saveProjectAs`/`newWorkspace`/`makeEnqueueDerivatives` (`workspace-orchestrator.ts`), `applyDerivativesEvent` (`jobs-writeback.ts`), `serializeProjectToJson` (`persistence.ts`), the regenerated napi methods (Task 2).
- Produces: the host's `persistence` handlers + a started autosave controller; `index.ts` routing `media:derivatives` to the TS actor.

- [ ] **Step 1: Wrap `takeSnapshot` copyFile (pre-flip checklist).** In `autosave.ts`:

```typescript
function takeSnapshot(ws: string): void {
  const src = deps.join(ws, PROJECT_FILE)
  if (!deps.fs.exists(src)) return
  const backups = deps.join(ws, BACKUPS_DIR)
  try {
    deps.fs.mkdirp(backups)
    deps.fs.copyFile(src, deps.join(backups, `${stamp()}.json`))
    gcSnapshots(backups)
  } catch { /* best-effort, matches Rust warn-and-continue; a setTimeout-callback throw would be an unhandled rejection */ }
}
```

- [ ] **Step 2: Extend the host to build persistence + autosave.** Add to `TsActorHostDeps` the injected facades and construct in `createTsActorHost`:

```typescript
// added deps:
//   napi: WorkspaceNapi (from workspace-orchestrator) + enqueueJobsForMedia
//   fs: OrchestratorFs & AutosaveFs (node:fs adapter)
//   join: node:path.join
//   workspaceDir: () => string | null  (cached from backend.invoke('workspace_dir'))
```

In the factory, build:

```typescript
import { createAutosave } from './autosave'
import { openProject, saveProjectAs, newWorkspace, makeEnqueueDerivatives, type WorkspaceNapi, type OrchestratorFs } from './workspace-orchestrator'
import { serializeProjectToJson } from './persistence'

const autosave = createAutosave({
  actor, fs: deps.fs, workspaceDir: deps.workspaceDir, join: deps.join, serialize: serializeProjectToJson,
})
const enqueueDerivatives = makeEnqueueDerivatives(deps.napi)
const orchestratorDeps = { actor, napi: deps.napi, fs: deps.fs, join: deps.join, idGen: uuidV7Gen(), enqueueDerivatives }
const persistence: PersistenceHandlers = {
  open: (dir) => openProject(orchestratorDeps, dir),
  saveAs: (dir) => saveProjectAs(orchestratorDeps, dir),
  newWorkspace: (a) => newWorkspace(orchestratorDeps, a),
  save: () => autosave.forceFlush(),
}
```

Wire `autosave.start()` into the host's `start()` and `autosave.stop()` into `stop()`. Set `deps.persistence = persistence` internally so the Task-4 routes resolve. (Restructure so persistence is built inside the factory rather than passed in.)

- [ ] **Step 3: Build the node adapters + inject in `index.ts`.** Where the host is constructed (Task 4 Step 5), pass real facades:

```typescript
const nodeFs = {
  exists: (p: string) => fs.existsSync(p),
  readFile: (p: string) => fs.readFileSync(p, 'utf8'),
  writeFile: (p: string, t: string) => fs.writeFileSync(p, t, 'utf8'),
  mkdirp: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
  copyFile: (s: string, d: string) => fs.copyFileSync(s, d),
  readdir: (d: string) => fs.readdirSync(d),
  rm: (p: string) => { fs.rmSync(p, { force: true }) },
}
const napiFacade /*: WorkspaceNapi */ = {
  commitWorkspace: (p: string) => backend!.commitWorkspace(p),
  pushRecent: (p: string, n: string) => backend!.pushRecent(p, n),
  setLastNewProjectParent: (p: string) => backend!.setLastNewProjectParent(p),
  enqueueJobsForMedia: (j: string) => backend!.enqueueJobsForMedia(j),
}
let wsCache: string | null = null
const workspaceDir = () => wsCache
// refresh wsCache from backend after each commitWorkspace (the orchestrator calls it),
// and once at boot: wsCache = JSON.parse(await backend.invoke('workspace_dir','{}'))
```

Provide `napi: napiFacade`, `fs: nodeFs`, `join: path.join`, `workspaceDir` to `createTsActorHost`. **Ordering caveat (spec risk #6):** the orchestrator calls `napi.commitWorkspace(dir)` itself before `replaceState`; after it resolves, refresh `wsCache` so `project_summary`'s `fileExists` + autosave see the new workspace. Refresh `wsCache` after `open`/`saveAs`/`newWorkspace` return (or have the napi facade's `commitWorkspace` update `wsCache` as a side effect).

- [ ] **Step 4: Set derivative authority + route the write-back event.** In `index.ts`, when `tsActorOn`, after constructing the host: `backend.setTsDerivativeAuthority(true)`. In the `onEvent` closure (the `new Backend(...)` callback), add a branch BEFORE the generic `mainWindow?.webContents.send`:

```typescript
if (event === 'media:derivatives') {
  if (tsHost) { void import('./state/jobs-writeback.js').then(({ applyDerivativesEvent }) => applyDerivativesEvent(tsHost!.actor, payload as never)) }
  return
}
```

(`onEvent` is constructed before `tsHost`; it closes over the module-scoped `tsHost` variable, set later — same late-binding pattern as `mcpHostRef`. Make `tsHost` module-scoped like `mcpHostRef`.)

- [ ] **Step 5: Add a persistence-route integration test (in-memory).** In `ts-actor-host.test.ts`, build a host with in-memory `fs`/`napi` stubs + `WEFTCUT_TS_ACTOR`-style deps, then exercise `handleInvoke('project_new_workspace', {...})` → `handleInvoke('project_summary',{})` reflects the new blank → a mutation via `handleInvoke('add_track', {})` → `handleInvoke('project_save', {})` writes `project.json` to the in-memory fs. Assert the written bytes parse and round-trip. (Mirrors the 3c-ii-b orchestrator round-trip but through the host's invoke surface.)

- [ ] **Step 6: Run unit + typecheck.**

Run: `npm --prefix apps/desktop run test -- ts-actor-host autosave workspace-orchestrator jobs-writeback`
Expected: PASS.
Run: `npm --prefix apps/desktop run typecheck` — Expected: clean (the napi facade typechecks against the regenerated `index.d.ts` from Task 2).

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/state/autosave.ts apps/desktop/src/main/index.ts apps/desktop/src/main/state/ts-actor-host.test.ts
git commit -m "feat(state-migration): live persistence + autosave + jobs write-back wiring behind the flag (Phase 3c-ii-d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: MCP category-A mutation pause (D6)

**Files:**
- Create: `apps/desktop/src/main/mcp/mutationTools.ts`
- Test: `apps/desktop/src/main/mcp/mutationTools.test.ts`
- Modify: `apps/desktop/src/main/mcp/server.ts:49-74` (CallTool handler)

**Interfaces:**
- Produces: `MUTATION_TOOLS: ReadonlySet<string>` (the category-A MCP mutation tool names) + `isPausedUnderTsActor(toolName: string): boolean` (true iff `WEFTCUT_TS_ACTOR==='1'` AND the tool mutates state).

- [ ] **Step 1: Enumerate the category-A MCP mutation tools.** Read the MCP tool catalog (`native/src/mcp/catalog.rs` / `mcp/tools.rs`) and list every tool that mutates project state (the analogues of the renderer category-A set plus the MCP-only mutations: markers, tracks, transitions, group-member ops, captions, keyframe algos, `apply_subtitles`, `add_motif`, `checkpoint`/`restore_checkpoint`, `begin_agent_session`, the `add_*_layer` family, etc.). Read-only tools (`project_summary`-equivalent resources, `list_motifs`, `dry_run`) are NOT in the set.

- [ ] **Step 2: Write the failing gate test.** `mutationTools.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { isPausedUnderTsActor, MUTATION_TOOLS } from './mutationTools'

afterEach(() => { delete process.env['WEFTCUT_TS_ACTOR'] })

describe('isPausedUnderTsActor', () => {
  it('pauses a category-A mutation tool only when the flag is on', () => {
    const tool = [...MUTATION_TOOLS][0]
    process.env['WEFTCUT_TS_ACTOR'] = '1'
    expect(isPausedUnderTsActor(tool)).toBe(true)
    delete process.env['WEFTCUT_TS_ACTOR']
    expect(isPausedUnderTsActor(tool)).toBe(false)
  })
  it('never pauses a non-mutation tool', () => {
    process.env['WEFTCUT_TS_ACTOR'] = '1'
    expect(isPausedUnderTsActor('list_motifs')).toBe(false)
  })
})
```

- [ ] **Step 3: Run; verify it fails.** Run: `npm --prefix apps/desktop run test -- mutationTools` — Expected: FAIL.

- [ ] **Step 4: Implement `mutationTools.ts`** with the enumerated set + the predicate.

- [ ] **Step 5: Gate the CallTool handler.** In `server.ts`, at the top of the `CallToolRequestSchema` handler (before the `preview_motif_draft` special-case and the `mcpCallTool` fallthrough):

```typescript
if (isPausedUnderTsActor(req.params.name)) {
  const e = new Error('Editing is paused while the TS state actor is active (WEFTCUT_TS_ACTOR). Agent mutations resume after the Phase 3d MCP port.') as Error & { code?: number }
  e.code = -32600 // invalid_request
  throw e
}
```

- [ ] **Step 6: Run tests + typecheck.** Run: `npm --prefix apps/desktop run test -- mutationTools`; `npm --prefix apps/desktop run typecheck` — Expected: PASS / clean.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/mcp/mutationTools.test.ts apps/desktop/src/main/mcp/server.ts
git commit -m "feat(state-migration): pause MCP category-A mutations under WEFTCUT_TS_ACTOR (D6, Phase 3c-ii-d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Pre-flip Rust hygiene + flag-on `_electron` e2e

**Files:**
- Modify: `apps/desktop/native/src/state/actor.rs` (the two `TS_DERIVATIVE_AUTHORITY` toggle tests)
- Create: `apps/desktop/e2e/specs/ts-actor-flip.e2e.js`

**Interfaces:** none (test-only).

- [ ] **Step 1: Serialize the authority-toggle tests (pre-flip checklist (a)).** Find the two tests that flip the process-global `TS_DERIVATIVE_AUTHORITY` AtomicBool (added in 3c-ii-c). If `serial_test` is already a dev-dependency, annotate both with `#[serial]`; else fold them into one `#[test]` that sets→asserts→resets, or document `RUST_TEST_THREADS=1`. The goal: a future parallel jobs/authority test can't race the global. Run `cargo test -p weftcut_lib --lib set_ts_derivative_authority` (or the matching filter) twice — Expected: deterministic pass.

- [ ] **Step 2: Write the flag-on e2e (CONTROLLER-run).** `ts-actor-flip.e2e.js` (Playwright `_electron`, mirrors the existing conformance e2e harness; needs the `VITE_WEFTCUT_E2E=1` build + `WEFTCUT_TS_ACTOR=1` in the launched app's env):
  - Launch the built app with `env: { ...process.env, WEFTCUT_TS_ACTOR: '1', WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' }`.
  - New workspace (or open a fixture) → assert `project_summary` reflects the blank.
  - Add a color layer (UI or `window.api` invoke) → assert the timeline/summary shows the new layer (the TS actor served it + emitted `project:changed`).
  - Undo → layer gone; redo → back.
  - Save → reopen the workspace in a fresh window → identical summary (autosave/orchestrator round-trip on the TS actor).
  - Assert `Backups/` contains a snapshot after a forced save.

- [ ] **Step 3: Run the e2e (CONTROLLER, build env).**

```
# build the e2e bundle + addon, then:
npx playwright test apps/desktop/e2e/specs/ts-actor-flip.e2e.js
```

Expected: PASS. (If the `_electron` harness can't run in this environment, the controller records a MANUAL SOAK instead: launch `WEFTCUT_TS_ACTOR=1`, perform the edit→save→reopen loop by hand, confirm parity — the spec's manual-soak gate.)

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/native/src/state/actor.rs apps/desktop/e2e/specs/ts-actor-flip.e2e.js
git commit -m "test(state-migration): serialize authority-toggle tests + flag-on e2e (Phase 3c-ii-d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full-suite gate + docs + carry-forwards

**Files:**
- Modify: `apps/desktop/fixtures/state-corpus/README.md`
- (No source change beyond docs.)

- [ ] **Step 1: Full TS suite + typecheck.**

Run: `npm --prefix apps/desktop run test` — Expected: ALL green (the prior differential gates `commands.differential`/`differential.phase2`/`summary.differential`/`persistence.differential` + the new `router`/`ts-actor-host`/`mutationTools` + `commands.test` auto-pair); `skipped===[]` on every differential gate.
Run: `npm --prefix apps/desktop run typecheck` — Expected: clean.

- [ ] **Step 2: Rust gate (CONTROLLER, build env).**

Run: `cargo test -p weftcut_lib --lib` (and `--features motifs` where the prior slices ran it) — Expected: green, incl. the serialized authority-toggle tests.

- [ ] **Step 3: Additivity check.**

Run: `git diff --stat --diff-filter=M -- apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod`
Expected: only the 3 new `oracle-prod` auto-pair files are ADDED (filter `A`); ZERO pre-existing oracles MODIFIED.

- [ ] **Step 4: Update the corpus README.** Add the auto-pair seqs to the prod-corpus section; document that `add_motif` + `project_restore_checkpoint` are rejected under the flag (deferred to 3d); note the flip's single-writer invariant + the flag default-off.

- [ ] **Step 5: Record the 3d / Phase-4 carry-forwards** (in the README + the SDD ledger):
  - **3d:** port the full MCP category-A surface (the `MUTATION_TOOLS` set) onto the TS actor and un-pause; port `add_motif` (needs the motif catalog in TS) + `project_restore_checkpoint` (TS checkpoint command surface) — the two flip-blocked renderer channels; re-point `project://` resources + read tools to the TS actor (MCP reads are stale during the soak).
  - **Phase 4:** delete the Rust state actor; remove the kept-fallback `invoke` state arms + the now-dead autosave/jobs-in-Rust paths; `fresh_media_item` (jobs/mod.rs:702) still reads the stale Rust actor (3c-ii-c carry-forward (d)).
  - **agent_session_end** history-unlock seam → TS (3d); **jobs actor attribution** (Agent{jobs} vs default) is a cosmetic broadcast-only difference (3c-ii-c carry-forward (c)).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/fixtures/state-corpus/README.md
git commit -m "docs(state-migration): corpus README + 3d/Phase-4 carry-forwards (Phase 3c-ii-d)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review checklist

- **Spec coverage:** §3c-ii-d `backend:invoke` splitter → Task 4/5; event emission shape → Task 4 (`mapChangeEvent`); MCP pause (D6) → Task 6; ramp/flag default-off → Global Constraints + Task 4; auto-pair hard-gate → Task 1; persistence/autosave/jobs go live together (F2) → Tasks 4/5 behind one flag. Spec exit gates: prod-differential (Task 1), unit (Tasks 3-6), flag-on e2e + soak (Task 7), all prior gates green (Task 8). napi regen carry-forward → Task 2. Pre-flip checklist (3c-ii-c) → Task 5 (copyFile try/catch) + Task 7 (serialize toggle tests).
- **Decisions honored:** D1 (det-id prod-differential is the gate, not live shadow) → Task 1; D5 (event-based jobs write-back) → Task 5; D6 (pause MCP) → Task 6; D7 (one flag, fallback) → Global Constraints.
- **Type consistency:** `routeChannel`/`Route`/`BLOCKED_UNDER_FLAG` (Task 3) consumed verbatim in Task 4; `PersistenceHandlers`/`TsActorHostDeps`/`mapChangeEvent` (Task 4) extended in Task 5; `MediaLayerResult.autoPairAudio` (Task 1) consumed in the same task's actor arm; `WorkspaceNapi`/`OrchestratorFs`/`AutosaveFs` facades (Task 5) match the 3c-ii-b/c interfaces verbatim.
- **Open verifications folded into steps (not placeholders):** `AudioMetadata` serde shape (Task 1 Step 3-4); `ProjectSettingsPatch.auto_pair_audio_on_import` existence (Task 1 Step 2); the renderer invoke-error contract (Task 4 Step 3 note); the derivative-authority napi export name (Task 2 Step 2); the MCP mutation-tool enumeration (Task 6 Step 1); `project_summary` `fileExists` source confirmed = injected predicate (`summary.ts:181`).
