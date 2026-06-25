# Phase 3d-e — native-compute input re-point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the native-compute stale-actor gap (audit findings F1–F7) so that under `WEFTCUT_TS_ACTOR` no Rust channel reads or writes the frozen Rust project actor — the last prerequisite before the flag can go default-on.

**Architecture:** Two mechanisms. (1) **Read re-point** — Rust read handlers swap `backend.project()?.snapshot()` → `backend.snapshot_for_read()` (the 3d-d TS read-mirror), and F4's direct derivative write routes through the existing `commit_media_derivatives` seam. (2) **Native-compute → TS-write hybrid** — write-bearing channels (`import_media`, `apply_subtitles`, `synthesize_speech`, motif `install_motif`/`acknowledge_motif_staleness`) split into a granular Rust compute napi (no actor write) + a TS host write step, orchestrated in `ts-actor-host.ts handleInvoke` (renderer) and `mcp/server.ts handleCallTool` (MCP). A durable router-partition + Rust source-scan gate proves no project-touching channel routes to Rust.

**Tech Stack:** Rust (napi-rs addon `@weftcut/core`, features `jobs`/`export`/`cloud`/`motifs`), TypeScript (Electron main: `src/main/state/*`, `src/main/mcp/*`), Vitest (esbuild), Playwright `_electron` e2e, the det-id differential corpus under `fixtures/state-corpus/`.

## Global Constraints

- Predecessor HEAD: `74a78d71` (3d-e spec) on local `main`, NOT pushed. Work continues on `main` (migration convention); stage by explicit path (parallel sessions edit this checkout).
- Flag `WEFTCUT_TS_ACTOR` stays **default-OFF**; every change is dormant flag-off (flag-off behavior must stay byte-identical). 3d-e only *unblocks* the eventual flip; the flip is the user's post-soak call.
- NO catalog port. `do_rebind_motif` is catalog-free. The motif catalog (`motif_cap_us`/`builtins()`), `add_motif`, and the `update_layer_params` Motif content-window clamp all stay Phase 4. The Rust motif **store** stays Rust.
- The wasm eval leaf is sacred: do not touch `snap.ts`/`renderer/eval`; engine-source-drift + snap-math-drift goldens must stay green.
- `TimeUs = number`; preference patches stay unrecorded.
- Corpus regen is ADDITIVE: `git diff --diff-filter=M fixtures/state-corpus` must be ∅ (no pre-existing oracle modified). All differential gates assert `skipped===[]`.
- Build/regen toolchain env (controller-run; the implementer must use it for any `cargo`/`napi:build`/oracle regen): `FFMPEG_DIR=<…Gyan.FFmpeg.Shared…/ffmpeg-8.1.1-full_build-shared>`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH+=$FFMPEG_DIR/bin`; build features `replay,jobs,export,mcp,cloud,motifs`.
- `native/index.d.ts` is gitignored — regenerated on `napi:build`, not committed. Any new `#[napi]` method must be regenerated in the implementation env before the TS host can call it.
- Evergreen docs: this plan is a dated snapshot; `docs/` design docs stay date/phase-free.
- Per-task: `tsc -b` clean (per-task reviewers run vitest under esbuild, which does NOT typecheck — the controller MUST run `tsc -b`), full vitest green, Rust lib tests green where touched.
- Spec: `docs/superpowers/specs/2026-06-25-state-actor-phase-3d-e-design.md`.

## File Structure

**Rust (`native/src/`)**
- `commands/export.rs` — F1/F2 read re-point (modify `export_project_audio_only`, `ensure_export_audio_conform`).
- `commands/media.rs` — F4/F5/F6 read re-point + F4 seam (modify `ensure_full_proxy`, `ensure_conform`, `get_media_thumbnail`, `get_waveform_peaks`); + new pure `probe_media_item` compute fn (extract from `import_media`).
- `commands/motif_authoring.rs` — F7-read re-point (`motif_staleness_report`); split the rebind-compute out of `install_motif`/`acknowledge_motif_staleness` into pure `compute_*_rebind` fns returning `Vec<MotifRebindEntry>`.
- `commands/mutations.rs` — split `import_subtitles` into a pure `parse_subtitle_cues` (parse half) keeping the existing fn as the flag-off path.
- `mcp/tools.rs` — split `synthesize_speech` compute (extract `synthesize_speech_audio` → `MediaItem`+`cached`).
- `napi_backend.rs` — new `#[napi]` compute methods: `probe_media`, `parse_subtitles`, `compute_motif_rebind`, `compute_ack_motif_rebind`, `synthesize_speech_compute`; `MotifRebindEntry` Serialize for the JSON boundary.
- `bin/replay_driver.rs` — `add_layer` Motif params builder + `rebind_motif` arm (corpus vehicle for the TS port).

**TypeScript (`src/main/state/`)**
- `mutations/motif.ts` (new) — pure `applyRebindMotif(draft, updates)`.
- `actor.ts` — `rebind_motif` dispatch arm.
- `replay.ts` — `rebind_motif` in `SUPPORTED_OPS` + `buildArgs`.
- `model.ts` — `MotifRebindEntry` TS type (if not present).
- `router.ts` — explicit allowlists + `{kind:'hybrid', tool}` Route + reject-unclassified default.
- `router.test.ts` — partition gate.
- `hybrids.ts` (new) — pure hybrid orchestration: `runHybrid(tool, args, deps)` shared by renderer + MCP; per-tool compute-napi-call + TS-write.
- `ts-actor-host.ts` — `compute` napi facade in deps; `handleInvoke` `hybrid` case.
- `__tests__/hybrids.test.ts` (new) — unit tests with injected fake compute napi + real TS actor.

**TypeScript (`src/main/mcp/`)**
- `mutationTools.ts` — remove the ported hybrids from `MCP_BLOCKED_UNDER_FLAG`; add a `'hybrid'` `McpRoute`.
- `server.ts` — `handleCallTool` `hybrid` branch.

**e2e (`e2e/electron/`)**
- `ts-actor-native-compute.spec.ts` (new) — flag-on import + export-audio.

**Native invariant test**
- `native/src/napi_backend.rs` (test mod) — source-scan asserting mirror-backed reads + F4 seam.

---

### Task 1: Group A read re-points + F4 write-seam fix (Rust)

Make the read-only / read-then-seam native handlers serve fresh state via the mirror under the flag. Channels stay `{kind:'rust'}`; only the Rust handler bodies change. Flag-off: `snapshot_for_read()` falls back to `project()?.snapshot()`, so behavior is identical.

**Files:**
- Modify: `native/src/commands/export.rs:34-36`, `:107-113`
- Modify: `native/src/commands/media.rs:142-143`, `:154-155`, `:167-168,176-182`, `:189-190`
- Modify: `native/src/commands/motif_authoring.rs:61`
- Test: `native/src/commands/media.rs` (test mod), `native/src/commands/export.rs` (test mod)

**Interfaces:**
- Consumes: `Backend::snapshot_for_read(&self) -> Result<Arc<Project>, String>` (`napi_backend.rs:494`, async); `crate::jobs::commit_media_derivatives(events: &Arc<dyn EventSink>, project: &ProjectHandle, media_id: MediaId, patch: MediaDerivativesPatch) -> Result<(), CommandError>` (`jobs/mod.rs:77`, `pub(crate)`).
- Produces: nothing new — same channel signatures.

- [ ] **Step 1: Write a failing Rust test that a read handler serves the mirror, not the actor.** In `native/src/commands/media.rs` test mod (use `Backend::new_for_test`, then `backend.set_project_mirror(project_json, history_json)` with a project whose `media_pool` contains a thumbnail-bearing item NOT in the actor). Assert `get_media_thumbnail` resolves the item from the mirror (e.g. returns `not_ready` for a mirror-only item rather than `media … not found`). Mirror a similar test for `ensure_full_proxy` asserting it calls the seam (set `set_ts_derivative_authority(true)` + a `VecEventSink`, assert a `media:derivatives` event is emitted, NOT a direct actor write).

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_media_thumbnail_reads_mirror_not_actor() {
    let sink = std::sync::Arc::new(crate::events::VecEventSink::new());
    let b = crate::napi_backend::Backend::new_for_test(sink);
    b.init().await.unwrap();
    // A media item present ONLY in the mirror (actor stays blank).
    let mut p = (*b.project().unwrap().snapshot().await).clone();
    let id = uuid::Uuid::now_v7();
    p.media_pool.insert(id, mirror_only_item(id)); // helper: kind Video, thumbnails_dir=None
    b.set_project_mirror(serde_json::to_string(&p).unwrap(), "{}".into()).unwrap();
    // thumbnails_dir is None → "not_ready" proves the item was FOUND via the mirror
    // (a blank-actor read would be "media … not found").
    let err = b.dispatch("get_media_thumbnail", &format!("{{\"media_id\":\"{id}\"}}")).await.unwrap_err();
    assert_eq!(err, "not_ready");
}
```

- [ ] **Step 2: Run it, verify it fails** (`media … not found`, because the handler reads the blank actor).
Run: `cargo test -p weftcut-core --features jobs,export,motifs get_media_thumbnail_reads_mirror_not_actor`
Expected: FAIL with `media … not found`.

- [ ] **Step 3: Re-point the read handlers.** In each handler replace `let handle = backend.project()?; let snap = handle.snapshot().await;` with `let snap = backend.snapshot_for_read().await?;`. For `ensure_conform`/`ensure_export_audio_conform` (which pass `handle` to `enqueue_*`), keep a separate `let handle = backend.project()?;` for the enqueue call ONLY, and read from `snap = backend.snapshot_for_read().await?`. Exact edits:
  - `export_project_audio_only`: `let snap = backend.snapshot_for_read().await?; let project = (*snap).clone();` (drop `let handle = backend.project()?;`).
  - `ensure_export_audio_conform`: `let snap = backend.snapshot_for_read().await?; let handle = backend.project()?;` then use `snap`/`&snap` for `conform_waiting_media` + `snap.media_pool.get`, `handle.clone()` for `enqueue_conform`.
  - `get_media_thumbnail`/`get_waveform_peaks`: `let snap = backend.snapshot_for_read().await?;` (drop the handle).
  - `ensure_conform`: `let snap = backend.snapshot_for_read().await?; let handle = backend.project()?;` — `snap` for the item read, `handle.clone()` for `enqueue_conform`.
  - `motif_staleness_report` (`motif_authoring.rs:61`): `let snap = b.snapshot_for_read().await?;` (drop `b.project()?.snapshot()`).

- [ ] **Step 4: Fix F4 `ensure_full_proxy` (read + seam).** Replace the read with `let snap = backend.snapshot_for_read().await?;` and replace the direct `handle.set_media_derivatives(Actor::Agent{client:"jobs"}, id, …)` with the seam:

```rust
pub async fn ensure_full_proxy(backend: &Backend, media_id: String) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let snap = backend.snapshot_for_read().await?;
    let Some(item) = snap.media_pool.get(&id).cloned() else { return Err(format!("no media {media_id}")); };
    if item.proxy_path.as_ref().map(|p| p.is_file()).unwrap_or(false) { return Ok(()); }
    let handle = backend.project()?;
    crate::jobs::commit_media_derivatives(
        &backend.events, handle, id,
        state::MediaDerivativesPatch { export_uses_original: Some(false), ..Default::default() },
    ).await.map_err(|e| format!("route-correct {media_id}: {e}"))?;
    crate::jobs::enqueue_full_proxy(backend.events.clone(), backend.cache.clone(), handle.clone(), item);
    Ok(())
}
```

- [ ] **Step 5: Run the tests, verify they pass.**
Run: `cargo test -p weftcut-core --features jobs,export,motifs get_media_thumbnail_reads_mirror_not_actor ensure_full_proxy_routes_through_seam`
Expected: PASS.

- [ ] **Step 6: Run the full Rust lib suite for the touched crates.**
Run: `cargo test -p weftcut-core --features jobs,export,motifs,cloud,mcp --lib`
Expected: PASS (628+ pre-existing, no regressions).

- [ ] **Step 7: Commit.**

```bash
git add native/src/commands/export.rs native/src/commands/media.rs native/src/commands/motif_authoring.rs
git commit -m "fix(state-migration): Group A read re-points + F4 derivative-seam (Phase 3d-e)"
```

---

### Task 2: `rebind_motif` TS actor port + differential gate

Port the trivial `do_rebind_motif` mutation to the TS actor and gate it against a regenerated oracle. This is the WRITE the motif hybrids (Task 5) call. No catalog.

**Files:**
- Create: `src/main/state/mutations/motif.ts`
- Modify: `src/main/state/model.ts` (add `MotifRebindEntry` type), `src/main/state/actor.ts` (`rebind_motif` dispatch arm), `src/main/state/replay.ts` (`SUPPORTED_OPS` + `buildArgs`)
- Modify: `native/src/bin/replay_driver.rs` (`add_layer` Motif builder + `rebind_motif` arm), `native/src/state/actor.rs` (derive `Serialize` on `MotifRebindEntry` if the napi boundary needs it — Task 5 confirms)
- Create corpus: `fixtures/state-corpus/sequences/rebind-motif-*.json`
- Test: `src/main/state/__tests__/differential.phase2.test.ts` (existing gate picks up new seqs)

**Interfaces:**
- Consumes: the actor `commit(summary, affected, diffHint, recipe)` pipeline (`actor.ts`), `Cue`/dispatch-arm precedent (`actor.ts:423`).
- Produces: `applyRebindMotif(draft: Project, updates: MotifRebindEntry[]): void`; dispatch channel `'rebind_motif'` with args `{ updates: MotifRebindEntry[] }`; `MotifRebindEntry = { layer_id: string; motif_id: string; motif_version: number; props: Record<string, unknown> }`.

- [ ] **Step 1: Add the TS type.** In `model.ts`, near `MotifParams`:

```ts
export interface MotifRebindEntry {
  layer_id: string; motif_id: string; motif_version: number; props: Record<string, unknown>
}
```

- [ ] **Step 2: Write the failing dispatch unit test.** In a new `src/main/state/__tests__/motif.rebind.test.ts`: create an actor, add a track, add a Motif layer (via `dispatch('add_layer', { track, kind:'Motif', motif_id:'x', motif_version:1, props:{a:1}, t_start_us:0, duration_us:1_000_000 })` — the Motif builder is added in Step 4), then `dispatch('rebind_motif', { updates:[{layer_id, motif_id:'y', motif_version:2, props:{b:2}}] })`. Assert the layer's params are `{kind:'Motif', motif_id:'y', motif_version:2, props:{b:2}}` and one history entry was recorded.

- [ ] **Step 3: Run it, verify it fails** (`add_layer` has no `Motif` kind / `rebind_motif` unknown).
Run: `npx vitest run src/main/state/__tests__/motif.rebind.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `applyRebindMotif` + the dispatch arms.** Create `mutations/motif.ts`:

```ts
import type { Project } from '../model'
import type { MotifRebindEntry } from '../model'

/** 1:1 port of do_rebind_motif (actor.rs:3711): set motif_id/version/props on the
 *  named Motif-param layers; non-Motif or missing layers are skipped. */
export function applyRebindMotif(draft: Project, updates: MotifRebindEntry[]): void {
  for (const u of updates) {
    for (const track of draft.tracks) {
      for (const layer of track.layers) {
        if (layer.id === u.layer_id && layer.params.kind === 'Motif') {
          layer.params.motif_id = u.motif_id
          layer.params.motif_version = u.motif_version
          layer.params.props = u.props as Record<string, unknown>
        }
      }
    }
  }
}
```

In `actor.ts dispatch()`, add a `Motif` arm to the existing `add_layer` builder (literal params — no catalog) and a `rebind_motif` arm mirroring `do_rebind_motif`'s `affected`/`DiffHint::Coarse`:

```ts
case 'rebind_motif': {
  const updates = a.updates as MotifRebindEntry[]
  const affected = updates.map((u) => u.layer_id)
  return { ok: true, value: commit('Rebound motif layers', affected, { kind: 'Coarse' }, (d) => applyRebindMotif(d, updates)) }
}
```

(For the `add_layer` Motif kind, build `{ kind:'Motif', motif_id, motif_version, props }` from `a.motif_id/a.motif_version/a.props` — match the existing kind-switch structure in the `add_layer` arm.)

- [ ] **Step 5: Run the unit test, verify it passes.**
Run: `npx vitest run src/main/state/__tests__/motif.rebind.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the replay vocab.** In `replay.ts`, add `'rebind_motif'` to `SUPPORTED_OPS` and a `buildArgs` case resolving `updates` (`@ref` layer ids inside each entry's `layer_id`). Add `add_layer` Motif support to `buildArgs` if the existing builder is kind-limited.

- [ ] **Step 7: Extend `replay_driver.rs`.** Add (a) an `add_layer` Motif params builder (`LayerParams::Motif(MotifParams{ motif_id, motif_version, props })` from literal corpus fields — props via `serde_json` object → `imbl::HashMap`); (b) a `rebind_motif` arm calling `h.rebind_motif(Actor::User, updates)` where `updates: Vec<MotifRebindEntry>` is parsed from the corpus (resolve `@ref` layer ids via the existing ref table). No catalog.

- [ ] **Step 8: Author corpus sequences.** Create `fixtures/state-corpus/sequences/rebind-motif-basic.json` (add_track @T → add_layer Motif @M on @T → rebind_motif updates=[{layer_id:@M, motif_id, motif_version, props}] → trailing `add_track` to pin the id counter) + `rebind-motif-multi.json` (two motif layers, one rebind across both). Register them in the corpus index if one exists (mirror how prior seqs are listed).

- [ ] **Step 9: Regenerate oracles (controller, toolchain env).** Build `replay_driver` and run the gen script; verify additivity.
Run: `node scripts/gen-state-oracle.mjs` (after `cargo build --features replay,jobs,export,mcp,cloud,motifs --bin replay_driver`)
Then: `git diff --diff-filter=M fixtures/state-corpus` → expect ∅ (only NEW oracle files added for the new seqs).

- [ ] **Step 10: Run the differential + summary gates.**
Run: `npx vitest run src/main/state/__tests__/differential.phase2.test.ts src/main/state/__tests__/summary.differential.test.ts`
Expected: PASS, `skipped===[]`, new seqs covered.

- [ ] **Step 11: Commit.**

```bash
git add src/main/state/mutations/motif.ts src/main/state/model.ts src/main/state/actor.ts src/main/state/replay.ts src/main/state/__tests__/motif.rebind.test.ts native/src/bin/replay_driver.rs fixtures/state-corpus/
git commit -m "feat(state-migration): port rebind_motif to the TS actor + differential gate (Phase 3d-e)"
```

---

### Task 3: Hybrid skeleton + router partition gate + `import_media` hybrid (F3)

Introduce the `{kind:'hybrid'}` Route, the explicit router allowlists + partition gate, the shared `hybrids.ts` orchestrator, the host compute-napi facade, and wire the first hybrid (`import_media`) end-to-end (renderer + MCP).

**Files:**
- Modify: `src/main/state/router.ts` (allowlists + `{kind:'hybrid', tool}` + reject default), `src/main/state/router.test.ts` (partition gate)
- Create: `src/main/state/hybrids.ts`, `src/main/state/__tests__/hybrids.test.ts`
- Modify: `src/main/state/ts-actor-host.ts` (deps `compute` facade + `handleInvoke` `hybrid` case)
- Modify: `src/main/index.ts` (build the `compute` facade from `backend`)
- Modify: `src/main/mcp/mutationTools.ts` (`'hybrid'` McpRoute + drop `import_media` from blocked), `src/main/mcp/server.ts` (`handleCallTool` hybrid branch)
- Modify: `native/src/napi_backend.rs` (`#[napi] probe_media`), `native/src/commands/media.rs` (extract pure `probe_media_item`)

**Interfaces:**
- Consumes: `actor.dispatch('add_media_item', { media })` (`actor.ts:241`), `napi.enqueueJobsForMedia(json)` (existing facade, `index.ts:223`).
- Produces:
  - `routeChannel` returns `{ kind:'hybrid'; tool: string }` for hybrid channels.
  - `hybrids.ts`: `export type HybridDeps = { actor: ActorHandle; compute: ComputeNapi; snapshotComposition: () => { width:number; height:number; duration_us:number } }`; `export async function runHybrid(tool: string, args: Record<string, unknown>, deps: HybridDeps): Promise<unknown>`.
  - `ComputeNapi` facade: `{ probeMedia(path:string): Promise<string /*MediaItemJson*/>; parseSubtitles(body:string, format:string|null): Promise<string>; computeMotifRebind(installArgsJson:string): Promise<string>; computeAckMotifRebind(): Promise<string>; synthesizeSpeechCompute(argsJson:string): Promise<string> }`.
  - napi `Backend.probeMedia(path: String) -> Promise<String>` returning a serialized `MediaItem`.

- [ ] **Step 1: Write the failing partition gate.** In `router.test.ts`, add a test that the full renderer-channel manifest (a hardcoded `ALL_CHANNELS` array mirroring `napi_backend.rs dispatch`, with a comment to keep in sync) is partitioned: every channel routes to exactly one bucket, and `import_media`/`install_motif`/`acknowledge_motif_staleness` route to `{kind:'hybrid'}`, and no channel routes to `{kind:'rust'}` outside a curated `PURE_NATIVE ∪ PERSISTENCE ∪ MIRROR_BACKED_READS ∪ DEBUG_ONLY` allowlist.

```ts
it('every renderer channel is classified; no project-touching channel routes to rust', () => {
  for (const ch of ALL_CHANNELS) {
    const r = routeChannel(ch)
    expect(r.kind, ch).not.toBe('reject') // every known channel is classified
    if (r.kind === 'rust') expect(RUST_ALLOWLIST.has(ch), `${ch} routes to rust`).toBe(true)
  }
  for (const ch of ['import_media','install_motif','acknowledge_motif_staleness'])
    expect(routeChannel(ch).kind, ch).toBe('hybrid')
})
```

- [ ] **Step 2: Run it, verify it fails** (router has no hybrid kind / allowlists).
Run: `npx vitest run src/main/state/router.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `router.ts` with explicit allowlists.** Add the `{ kind:'hybrid'; tool:string }` Route variant. Define:

```ts
/** Hybrid Rust-compute → TS-write channels (Phase 3d-e). */
export const HYBRID_CHANNELS: ReadonlySet<string> = new Set(['import_media','install_motif','acknowledge_motif_staleness'])
/** Read-only native handlers re-pointed to the read-mirror (Group A) — safe on rust. */
export const MIRROR_BACKED_READS: ReadonlySet<string> = new Set([
  'export_project_audio_only','ensure_export_audio_conform','ensure_conform','ensure_full_proxy',
  'get_media_thumbnail','get_waveform_peaks','motif_staleness_report',
])
/** Native compute with NO project actor access. */
export const PURE_NATIVE: ReadonlySet<string> = new Set([
  'ping','mux_export','export_video_sink_start','export_video_sink_finish','export_video_sink_cancel',
  'import_cancel','import_queue_list','report_audio_meter','settings_get_api_key_status','settings_test_provider',
  'list_motifs','get_motif_source','write_motif_draft','amend_motif_draft','create_edit_draft','import_motif','delete_motif',
])
/** Backend stores (config-dir), not the project actor. */
export const PERSISTENCE: ReadonlySet<string> = new Set([
  'app_settings_get','app_settings_set','view_state_get','view_state_set','export_settings_get','export_settings_set',
  'workspace_dir','recents_list','recents_remove','recents_get_reopen_on_launch','recents_set_reopen_on_launch',
  'recents_most_recent','recents_last_new_project_parent','keybindings_get','keybindings_set','keybindings_reset_all',
  'keybindings_export','keybindings_import','agent_session_get','log_list','log_clear','log_emit','log_dir_path',
])
/** debug_assertions-only, project-touching; dev tooling, not a release/flag-default-on risk. Phase-4. */
export const DEBUG_ONLY: ReadonlySet<string> = new Set(['debug_lock_history','debug_unlock_history','debug_simulate_agent_session'])
```

In `routeChannel`: order = PRODUCTION_OPS → HYBRID → BLOCKED → the special switch (summary/settings/persistence/agentSessionEnd) → `(PURE_NATIVE ∪ PERSISTENCE ∪ MIRROR_BACKED_READS ∪ DEBUG_ONLY).has(channel) ? {kind:'rust'} : {kind:'reject', reason:'unclassified channel under WEFTCUT_TS_ACTOR — classify in router.ts'}`.

- [ ] **Step 4: Run the partition gate, verify it passes.**
Run: `npx vitest run src/main/state/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Extract the pure probe + add the napi.** In `media.rs`, extract the body of `import_media`'s `spawn_blocking` (`:47-83`) into `pub fn probe_media_item(source_buf: PathBuf, has_workspace: bool) -> Result<MediaItem, String>` (the workspace-root decision stays the caller's; pass `has_workspace`). `import_media` (flag-off path) calls it unchanged. Add to `napi_backend.rs`:

```rust
#[napi]
#[cfg(feature = "jobs")]
pub async fn probe_media(&self, path: String) -> napi::Result<String> {
    let buf = std::path::PathBuf::from(&path);
    let has_workspace = self.workspace.current().is_some();
    let item = tokio::task::spawn_blocking(move || crate::commands::media::probe_media_item(buf, has_workspace))
        .await.map_err(|e| Error::from_reason(format!("probe join: {e}")))?
        .map_err(Error::from_reason)?;
    serde_json::to_string(&item).map_err(|e| Error::from_reason(e.to_string()))
}
```
(Subtitle paths are handled by the subtitle hybrid in Task 4; `probe_media` is for non-subtitle media. The hybrid orchestrator routes by extension — see Step 7.)

- [ ] **Step 6: Regenerate napi bindings (controller, toolchain env).**
Run: `npm run napi:build` (features `jobs,export,mcp,cloud,motifs`) — regenerates the gitignored `native/index.d.ts`; confirm `probeMedia` is present.

- [ ] **Step 7: Write the failing hybrid unit test.** In `hybrids.test.ts`: a real TS actor + a fake `compute` whose `probeMedia` returns a literal `MediaItem` JSON; call `runHybrid('import_media', { path:'C:/x.mp4' }, deps)`; assert (a) it returns the new media id, (b) `actor.snapshot().media_pool` contains the item, (c) `enqueueJobsForMedia` was called with the item. Add a subtitle-path case asserting it delegates to the subtitle compute (stub until Task 4; assert the orchestrator branches on `.srt`).

- [ ] **Step 8: Run it, verify it fails.**
Run: `npx vitest run src/main/state/__tests__/hybrids.test.ts`
Expected: FAIL (no `hybrids.ts`).

- [ ] **Step 9: Implement `hybrids.ts` + the `import_media` arm.**

```ts
export async function runHybrid(tool: string, args: Record<string, unknown>, deps: HybridDeps): Promise<unknown> {
  switch (tool) {
    case 'import_media': {
      const path = args.path as string
      if (/\.(srt|ass|vtt)$/i.test(path)) return deps.applySubtitleFile(path) // Task 4
      const item = JSON.parse(await deps.compute.probeMedia(path)) as { id: string }
      const r = deps.actor.dispatch('add_media_item', { media: item })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      await deps.enqueueDerivatives([item])     // existing makeEnqueueDerivatives seam
      return item.id
    }
    // install_motif / acknowledge_motif_staleness → Task 5; synthesize_speech/apply_subtitles → Tasks 4/6
    default: throw new Error(`runHybrid: unhandled tool ${tool}`)
  }
}
```

- [ ] **Step 10: Wire the host.** In `ts-actor-host.ts`: add `compute: ComputeNapi` + `enqueueDerivatives` to `TsActorHostDeps` (the latter already exists internally via `makeEnqueueDerivatives`), build `HybridDeps`, and add to `handleInvoke`:

```ts
case 'hybrid': return runHybrid(route.tool, args, hybridDeps)
```
In `index.ts`, build the `compute` facade: `compute: { probeMedia: (p) => backend!.probeMedia(p), /* parseSubtitles/computeMotifRebind/… added in later tasks */ }` and pass into `createTsActorHost`.

- [ ] **Step 11: Wire MCP.** In `mutationTools.ts`: drop `'import_media'` from `MCP_BLOCKED_UNDER_FLAG`; add `if (HYBRID_TOOLS.has(name)) return 'hybrid'` (a new set `{ 'import_media', … }`) before the `MCP_TOOLS` check. In `server.ts handleCallTool`, add a `route === 'hybrid'` branch calling `runHybrid(name, args, tsHost.hybridDeps)` and shaping the MCP `ToolResult` (`{content:[{type:'text',text:<id>}]}`).

- [ ] **Step 12: Run hybrid + router + host tests, verify pass; tsc.**
Run: `npx vitest run src/main/state/__tests__/hybrids.test.ts src/main/state/router.test.ts src/main/mcp/` then `npx tsc -b`
Expected: PASS; tsc clean.

- [ ] **Step 13: Commit.**

```bash
git add src/main/state/router.ts src/main/state/router.test.ts src/main/state/hybrids.ts src/main/state/__tests__/hybrids.test.ts src/main/state/ts-actor-host.ts src/main/index.ts src/main/mcp/mutationTools.ts src/main/mcp/server.ts native/src/napi_backend.rs native/src/commands/media.rs
git commit -m "feat(state-migration): hybrid skeleton + router partition gate + import_media hybrid (Phase 3d-e)"
```

---

### Task 4: `apply_subtitles` hybrid + `import_media` subtitle branch

Split `import_subtitles` into a pure parse napi + a TS caption-track write; serve both the MCP `apply_subtitles` tool and the renderer `import_media` subtitle branch.

**Files:**
- Modify: `native/src/commands/mutations.rs:709` (extract `parse_subtitle_cues`), `native/src/napi_backend.rs` (`#[napi] parse_subtitles`)
- Modify: `src/main/state/hybrids.ts` (`applySubtitleFile` + `apply_subtitles` arm), `src/main/state/__tests__/hybrids.test.ts`
- Modify: `src/main/mcp/mutationTools.ts` (drop `apply_subtitles` from blocked; add to `HYBRID_TOOLS`), `src/main/index.ts` (facade `parseSubtitles`)

**Interfaces:**
- Consumes: `actor.dispatch('add_caption_track', { cues, comp_w, comp_h, label })` (`actor.ts:423`); `actor.snapshot().composition.{width,height}`.
- Produces: napi `Backend.parseSubtitles(body: String, format: Option<String>) -> Result<String>` returning `{ cues: Cue[]; simplified: boolean }`; `hybrids.ts` `applySubtitleFile(path)` + `applySubtitleBody(body, format, label)`.

- [ ] **Step 1: Extract the pure parser.** In `mutations.rs`, factor the parse half (`:715-722`) into `pub fn parse_subtitle_cues(body: &str, format: Option<crate::subtitles::SubFormat>) -> Result<(Vec<crate::subtitles::Cue>, bool), String>` (empty-body + no-cues errors stay here). `import_subtitles` (flag-off path) calls it then `add_caption_track`.

- [ ] **Step 2: Add the napi.**

```rust
#[napi]
pub fn parse_subtitles(&self, body: String, format: Option<String>) -> napi::Result<String> {
    let fmt = format.map(|f| crate::subtitles::SubFormat::from_str(&f)).transpose().map_err(Error::from_reason)?;
    let (cues, simplified) = crate::commands::mutations::parse_subtitle_cues(&body, fmt).map_err(Error::from_reason)?;
    serde_json::to_string(&serde_json::json!({ "cues": cues, "simplified": simplified })).map_err(|e| Error::from_reason(e.to_string()))
}
```
(`SubFormat::from_str` may need adding — a small mirror of `sniff` tags; confirm in `subtitles/`.) Regenerate bindings (`napi:build`).

- [ ] **Step 3: Write the failing test.** In `hybrids.test.ts`: fake `parseSubtitles` returns a 2-cue payload; `runHybrid('apply_subtitles', { body:'…', format:null }, deps)` → assert a caption track with 2 Text layers exists in `actor.snapshot()` and the returned track id is non-empty. Add an `import_media` `.srt`-path case asserting it reads the file and routes to the same write.
Run: `npx vitest run src/main/state/__tests__/hybrids.test.ts` → FAIL.

- [ ] **Step 4: Implement.** In `hybrids.ts`:

```ts
async function applySubtitleBody(body: string, format: string | null, label: string | null, deps: HybridDeps) {
  const { cues, simplified } = JSON.parse(await deps.compute.parseSubtitles(body, format)) as { cues: unknown[]; simplified: boolean }
  const { width, height } = deps.snapshotComposition()
  const r = deps.actor.dispatch('add_caption_track', { cues, comp_w: width, comp_h: height, label })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return { track_id: r.value, simplified }
}
```
`apply_subtitles` arm → `applySubtitleBody(args.body, args.format ?? null, 'Captions', deps)` (shape the MCP result per `tools.rs:459`). `applySubtitleFile(path)` (renderer import) reads the file (host injects `fs.readFile`), derives the label from the filename, calls `applySubtitleBody(body, null, label, deps)`, returns `track_id`.

- [ ] **Step 5: Un-block + facade.** Drop `apply_subtitles` from `MCP_BLOCKED_UNDER_FLAG`, add to `HYBRID_TOOLS`; add `parseSubtitles` to the `index.ts` compute facade + inject `fs.readFile` into `HybridDeps`.

- [ ] **Step 6: Run tests + tsc, verify pass.**
Run: `npx vitest run src/main/state/__tests__/hybrids.test.ts src/main/mcp/` then `npx tsc -b`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add native/src/commands/mutations.rs native/src/napi_backend.rs src/main/state/hybrids.ts src/main/state/__tests__/hybrids.test.ts src/main/mcp/mutationTools.ts src/main/index.ts
git commit -m "feat(state-migration): apply_subtitles + import_media subtitle hybrid (Phase 3d-e)"
```

---

### Task 5: Motif hybrids — `install_motif` (Update) + `acknowledge_motif_staleness`

Keep the motif-store publish + the schema-aware rebind COMPUTE in Rust (reading the mirror), apply the rebind WRITE through the TS actor's `rebind_motif` (Task 2).

**Files:**
- Modify: `native/src/commands/motif_authoring.rs` (split `install_motif`/`acknowledge_motif_staleness` into compute fns returning `Vec<MotifRebindEntry>` + keep store ops), `native/src/napi_backend.rs` (`#[napi] install_motif_publish` + `compute_motif_rebind`/`compute_ack_motif_rebind`), `native/src/state/actor.rs` (derive `Serialize` on `MotifRebindEntry`)
- Modify: `src/main/state/hybrids.ts` (`install_motif`/`acknowledge_motif_staleness` arms), `src/main/state/__tests__/hybrids.test.ts`
- Modify: `src/main/mcp/mutationTools.ts` (drop both from blocked; add to `HYBRID_TOOLS`), `src/main/index.ts` (facade)

**Interfaces:**
- Consumes: `actor.dispatch('rebind_motif', { updates })` (Task 2).
- Produces: napi `Backend.computeMotifRebind(installArgsJson: String) -> Result<String /*{published_id, updates}*/>` (does store publish + reads mirror + `build_rebind_updates`); `Backend.computeAckMotifRebind() -> Result<String /*{count, updates}*/>`. The serialized `MotifRebindEntry[]` = `[{layer_id, motif_id, motif_version, props}]`.

- [ ] **Step 1: Make `MotifRebindEntry` serializable.** In `actor.rs:219`, add `Serialize, Deserialize` derives (props is `imbl::HashMap<String, Value>` — serde-compatible). Add a `#[serde(rename_all)]` only if the TS side needs it (TS uses snake_case `layer_id` — keep Rust field names, no rename).

- [ ] **Step 2: Split the compute.** In `motif_authoring.rs`, change `install_motif` so the Update-mode tail returns the updates instead of calling `handle.rebind_motif`: factor `install_motif_compute(store, mirror_snapshot, args) -> Result<(String /*published_id*/, Vec<MotifRebindEntry>), String>` (does `get_draft`/validate/write_draft/install_draft + `build_rebind_updates` against the mirror snapshot's motif layers). The flag-off `install_motif` (in `motif_authoring.rs`) keeps calling `handle.rebind_motif`. Likewise `acknowledge_motif_compute(store, mirror_snapshot) -> Result<(usize, Vec<MotifRebindEntry>), String>`.

- [ ] **Step 3: Add the napis.** Both read the mirror (`self.snapshot_for_read().await?`) for the layer extraction and the store for manifests; do the store publish (install) but NOT the actor write:

```rust
#[napi] #[cfg(feature = "motifs")]
pub async fn compute_motif_rebind(&self, install_args_json: String) -> napi::Result<String> {
    let args: crate::motifs::authoring_commands::InstallArgs = serde_json::from_str(&install_args_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let snap = self.snapshot_for_read().await.map_err(Error::from_reason)?;
    let (id, updates) = crate::commands::motif_authoring::install_motif_compute(&self.motif_store, &snap, &args).map_err(Error::from_reason)?;
    // motifs:changed emit stays here (store changed).
    serde_json::to_string(&serde_json::json!({ "published_id": id, "updates": updates })).map_err(|e| Error::from_reason(e.to_string()))
}
```
(`compute_ack_motif_rebind` analogous, returning `{count, updates}`.) Regenerate bindings.

- [ ] **Step 4: Write the failing test.** In `hybrids.test.ts`: a real actor with a Motif layer (motif_id 'm', v1); fake `computeMotifRebind` returns `{published_id:'m', updates:[{layer_id:<that layer>, motif_id:'m', motif_version:2, props:{}}]}`; `runHybrid('install_motif', { args:{…} }, deps)` → assert the layer's `motif_version` is now 2 and the return is `'m'`. Acknowledge case: fake returns `{count:1, updates:[…]}`; assert count returned + layer rebound.
Run: `npx vitest run src/main/state/__tests__/hybrids.test.ts` → FAIL.

- [ ] **Step 5: Implement the arms.**

```ts
case 'install_motif': {
  const { published_id, updates } = JSON.parse(await deps.compute.computeMotifRebind(JSON.stringify(args.args ?? args))) as { published_id: string; updates: unknown[] }
  if (updates.length) { const r = deps.actor.dispatch('rebind_motif', { updates }); if (!r.ok) throw new Error(JSON.stringify(r.error)) }
  return published_id
}
case 'acknowledge_motif_staleness': {
  const { count, updates } = JSON.parse(await deps.compute.computeAckMotifRebind()) as { count: number; updates: unknown[] }
  if (updates.length) { const r = deps.actor.dispatch('rebind_motif', { updates }); if (!r.ok) throw new Error(JSON.stringify(r.error)) }
  return count
}
```

- [ ] **Step 6: Un-block + facade.** Drop `install_motif`/`acknowledge_motif_staleness` from `MCP_BLOCKED_UNDER_FLAG` (note: `motif_staleness_report` is a mirror-backed READ — leave it un-blocked as a `rust` read, NOT a hybrid). Add both to `HYBRID_TOOLS` (MCP + renderer router already routes them via `HYBRID_CHANNELS`). Add `computeMotifRebind`/`computeAckMotifRebind` to the `index.ts` facade.

- [ ] **Step 7: Run tests + tsc + Rust motif tests, verify pass.**
Run: `npx vitest run src/main/state/__tests__/hybrids.test.ts` ; `npx tsc -b` ; `cargo test -p weftcut-core --features motifs,jobs --lib motif`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add native/src/commands/motif_authoring.rs native/src/napi_backend.rs native/src/state/actor.rs src/main/state/hybrids.ts src/main/state/__tests__/hybrids.test.ts src/main/mcp/mutationTools.ts src/main/index.ts
git commit -m "feat(state-migration): install_motif + acknowledge_motif_staleness hybrids (Phase 3d-e)"
```

---

### Task 6: `synthesize_speech` hybrid (MCP, cloud)

Split the TTS compute (synthesize + cache + probe → `MediaItem`) from the write (add_media_item + audio-track resolution + add_layer). MCP-only, `cloud`-gated.

**Files:**
- Modify: `native/src/mcp/tools.rs:2673` (extract `synthesize_speech_audio` → `(MediaItem, bool /*cached*/)`), `native/src/napi_backend.rs` (`#[napi] synthesize_speech_compute`)
- Modify: `src/main/state/hybrids.ts` (`synthesize_speech` arm + a TS `ensureAudioTrack`), `src/main/state/__tests__/hybrids.test.ts`
- Modify: `src/main/mcp/mutationTools.ts` (drop from blocked; add to `HYBRID_TOOLS`), `src/main/index.ts` (facade)

**Interfaces:**
- Consumes: `actor.dispatch('add_media_item', {media})`, `actor.dispatch('add_media_layer', {track_id, media_id, t_start_us})` OR `add_layer` Audio (match the renderer `add_media_layer` Voiceover path); `actor.snapshot().composition.duration_us` + `.tracks` (for audio-track resolution).
- Produces: napi `Backend.synthesizeSpeechCompute(argsJson: String) -> Result<String /*{media_item, duration_us, cached}*/>`; `hybrids.ts` `ensureAudioTrack(snapshot) → trackId | null` (topmost Audio-capable track or signal "create Voiceover track" — mirror `tools.rs ensure_audio_track:123-130`).

- [ ] **Step 1: Extract the compute.** Factor `tools.rs:2681-2777` (validate text → pick synthesizer → cache key → synthesize+write → probe → `MediaItem`) into `pub(crate) async fn synthesize_speech_audio(b:&Backend, args:&SynthesizeSpeechArgs) -> Result<(MediaItem, bool), McpToolError>`. The existing `synthesize_speech` (flag-off path) calls it then does the add_media_item/add_layer tail unchanged.

- [ ] **Step 2: Add the napi** (`cloud` feature). Returns `{ media_item, duration_us, cached }` as JSON; maps `McpToolError` → `Error::from_reason(err.message)`. Regenerate bindings.

- [ ] **Step 3: Write the failing test.** In `hybrids.test.ts`: fake `synthesizeSpeechCompute` returns a literal Audio `MediaItem` + `duration_us:2_000_000` + `cached:false`; pre-create an Audio track; `runHybrid('synthesize_speech', { text:'hi', voice:'…', speed:1, target_track_id:<track> }, deps)` → assert media in pool, an Audio layer placed `[duration default → duration]` on the track, and the result `{layer_id, media_id, t_start_us, t_end_us, cached}`.
Run: `npx vitest run src/main/state/__tests__/hybrids.test.ts` → FAIL.

- [ ] **Step 4: Implement** the `synthesize_speech` arm: parse compute result → `add_media_item` → kick `enqueueDerivatives([item])` → resolve `t_start_us = args.t_start_us ?? snapshot.duration_us`, `t_end_us = t_start + duration_us` → resolve the track (`target_track_id` or `ensureAudioTrack`; if none, dispatch `add_track` and stamp it Voiceover-capable — match `ensure_audio_track`) → place the Audio layer (Voiceover role) → return the result object. Port `ensureAudioTrack` faithfully (topmost track or a new "Voiceover" track).

- [ ] **Step 5: Un-block + facade.** Drop `synthesize_speech` from `MCP_BLOCKED_UNDER_FLAG`; add to `HYBRID_TOOLS`; add `synthesizeSpeechCompute` to the facade. (Renderer router unaffected — `synthesize_speech` is MCP-only; do NOT add it to `HYBRID_CHANNELS`.)

- [ ] **Step 6: Run tests + tsc, verify pass.**
Run: `npx vitest run src/main/state/__tests__/hybrids.test.ts src/main/mcp/` ; `npx tsc -b`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add native/src/mcp/tools.rs native/src/napi_backend.rs src/main/state/hybrids.ts src/main/state/__tests__/hybrids.test.ts src/main/mcp/mutationTools.ts src/main/index.ts
git commit -m "feat(state-migration): synthesize_speech hybrid (Phase 3d-e)"
```

---

### Task 7: Rust source-scan invariant + flag-on e2e + docs + full verification

The durable mechanical guard (the spec's #1 gate) + the behavioral proof that the silent-wrong-output bugs are gone.

**Files:**
- Create: `native/src/state/mirror_invariant.rs` test (or a test mod in `napi_backend.rs`)
- Create: `e2e/electron/ts-actor-native-compute.spec.ts`
- Modify: `fixtures/state-corpus/README.md`, MCP-blocked-set doc references

**Interfaces:** none new.

- [ ] **Step 1: Write the Rust source-scan invariant test.** Read the handler source via `CARGO_MANIFEST_DIR` and assert the mirror-backed reads use the mirror and the F4 write uses the seam:

```rust
#[test]
fn mirror_backed_reads_do_not_touch_the_stale_actor() {
    let root = env!("CARGO_MANIFEST_DIR");
    let media = std::fs::read_to_string(format!("{root}/src/commands/media.rs")).unwrap();
    let export = std::fs::read_to_string(format!("{root}/src/commands/export.rs")).unwrap();
    let motif = std::fs::read_to_string(format!("{root}/src/commands/motif_authoring.rs")).unwrap();
    // Each mirror-backed handler must read snapshot_for_read, and none may call
    // `.project()?.snapshot()` (the stale-actor read F1–F7 introduced).
    for src in [&media, &export, &motif] {
        assert!(!src.contains(".project()?.snapshot()"), "stale-actor snapshot read present");
    }
    assert!(media.contains("snapshot_for_read"), "media reads must use the mirror");
    assert!(export.contains("snapshot_for_read"), "export reads must use the mirror");
    // F4 routes through the seam, not a direct set_media_derivatives.
    let efp = &media[media.find("fn ensure_full_proxy").unwrap()..];
    let efp = &efp[..efp.find("\npub async fn ").map(|i| i).unwrap_or(efp.len())];
    assert!(efp.contains("commit_media_derivatives"), "ensure_full_proxy must use the seam");
    assert!(!efp.contains("handle\n        .set_media_derivatives"), "ensure_full_proxy direct write present");
}
```

- [ ] **Step 2: Run it, verify it passes** (Task 1 already fixed the handlers).
Run: `cargo test -p weftcut-core --features jobs,export,motifs mirror_backed_reads_do_not_touch_the_stale_actor`
Expected: PASS.

- [ ] **Step 3: Write the flag-on e2e.** In `e2e/electron/ts-actor-native-compute.spec.ts` (Playwright `_electron`, `WEFTCUT_TS_ACTOR=1`, `VITE_WEFTCUT_E2E=1` build): new_workspace → `import_media` a tiny bundled fixture media file via `window.api.backend.invoke('import_media', { path })` → `project_summary` shows the media in the pool (catches F3) → `export_project_audio_only` to a temp path → assert the output file exists and is non-empty/non-silent (catches F1/F2). Use the bundled e2e fixture media (mirror `media_conformance_harness` fixtures).

- [ ] **Step 4: Run the e2e (controller; built app).**
Run: `npx playwright test e2e/electron/ts-actor-native-compute.spec.ts`
Expected: PASS (media in summary; audio file non-empty).

- [ ] **Step 5: Update docs.** In `fixtures/state-corpus/README.md`, add the `rebind-motif-*` seqs + note 3d-e closed F1–F7. In `mutationTools.ts`/`router.ts` header comments, update the stale "ported in a later phase" / Phase-3d-e references to reflect what is now live vs Phase 4 (`add_motif`/`project_restore_checkpoint` remain blocked; the catalog/Motif-clamp remain Phase 4).

- [ ] **Step 6: Full verification (controller, toolchain env).**
Run: `npx vitest run` (full suite, all differential gates `skipped===[]`) ; `npx tsc -b` ; `cargo test -p weftcut-core --features jobs,export,mcp,cloud,motifs --lib` ; `git diff --diff-filter=M fixtures/state-corpus` (expect ∅).
Expected: all green; corpus additive.

- [ ] **Step 7: Commit.**

```bash
git add native/src/ e2e/electron/ts-actor-native-compute.spec.ts fixtures/state-corpus/README.md src/main/state/router.ts src/main/mcp/mutationTools.ts
git commit -m "test(state-migration): mirror-read invariant + flag-on native-compute e2e + docs (Phase 3d-e)"
```

---

## Self-Review

**Spec coverage:**
- A read re-points (F1/F2/F5/F6/F7-read) → Task 1. ✓
- B F4 seam → Task 1. ✓
- C hybrids: import_media (F3) → Task 3; apply_subtitles → Task 4; install_motif/acknowledge_motif_staleness (F7-write) → Task 5; synthesize_speech → Task 6. ✓ All un-blocked from `MCP_BLOCKED_UNDER_FLAG` in their task.
- rebind_motif TS port + gate → Task 2. ✓
- D architectural gate: router partition (Task 3) + Rust source-scan (Task 7). ✓
- E flag-on e2e → Task 7. ✓
- Out-of-scope (catalog/add_motif/Motif-clamp/F9) → untouched. ✓

**Placeholder scan:** verbatim-extraction steps point to exact source line ranges (an action, not a placeholder). No "TBD"/"add error handling"/"similar to". One known follow-through: `SubFormat::from_str` (Task 4 Step 2) may need adding — flagged inline with where to mirror it.

**Type consistency:** `MotifRebindEntry` fields (`layer_id`/`motif_id`/`motif_version`/`props`) identical across Rust (`actor.rs:220`), TS (`model.ts`), the napi JSON boundary, and the corpus. `runHybrid(tool, args, deps)` signature stable across Tasks 3–6. `ComputeNapi` methods (`probeMedia`/`parseSubtitles`/`computeMotifRebind`/`computeAckMotifRebind`/`synthesizeSpeechCompute`) defined in Task 3, extended additively. `HYBRID_CHANNELS` (renderer) vs `HYBRID_TOOLS` (MCP) kept distinct (synthesize_speech is MCP-only).

## Open risk flagged for execution
- `add_caption_track` dispatch arg names (`cues`/`comp_w`/`comp_h`/`label`, `actor.ts:423`) and the `add_media_layer`/`add_layer` Audio Voiceover path must be confirmed against live code at execution; the plan uses the names observed during planning.
- `ensure_audio_track` (Task 6) is MCP-specific (topmost track or new "Voiceover" track) and differs from the renderer auto-pair — port faithfully from `tools.rs:123-130`, do not reuse the 3c-ii-d Dialogue auto-pair.
- DEBUG_ONLY channels (`debug_*`) are carved out of the gate as dev-tooling/debug-assertions-only; if the flag-on e2e build enables `debug_assertions`, confirm they are not exercised by normal flows (they aren't — explicit dev commands only).
