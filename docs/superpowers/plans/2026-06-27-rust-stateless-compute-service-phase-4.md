# Rust stateless-compute-service — Phase 4: import hash-first rework

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real BLAKE3 content hash known **before** derivative jobs are enqueued, so every job bakes the final-hash `MediaItem` at enqueue time. This kills the `pending-{media_id}` placeholder, the copy-time `migrate_hash_artifacts` rename, `patch_derivative_paths_after_hash_migration` + `rewrite_hash_in_path`, and the per-job `fresh_media_item` mirror re-read — which is the **last consumer of the read-mirror handle outside the mirror's own definition** (Phase 5 then deletes the mirror wholesale).

**Architecture:** Spec `docs/superpowers/specs/2026-06-27-rust-stateless-compute-service-design.md` §2 + Risks + sequencing item 4 (variant B: remove the cause, not patch the symptom). The import hybrid (`hybrids.ts` `import_media`) becomes: stat-only probe → insert (clip appears instantly) → a lightweight standalone hash pass (`hash_media_source` napi) → set the real hash on the pool item (new `set_media_hash` TS mutation) → enqueue derivatives reading the **source** (content-addressed, so source vs workspace-copy is equivalent) → enqueue the workspace copy **in parallel**. Cost vs. today: one extra full read of the source (the standalone hash pass), accepted to keep derivatives starting promptly. The provisional representation is a **sentinel** (`file_hash_blake3 = "pending-{id}"`, the value probe already produces) — kept only because the `MediaItem.file_hash_blake3` field is non-optional; it is **never used as a cache key** because no derivative is enqueued until the real hash is set.

**Tech Stack:** Rust (napi-rs addon, `apps/desktop/native`), TypeScript (Electron main + TS state actor + hybrid orchestrator, `apps/desktop/src/main`). Rust async via tokio; `cargo test`. TS via vitest.

## Global Constraints

- Native Rust build/test MUST pass `--features export,mcp,cloud` — the default (no-feature) build does not compile. (`export` and `cloud` both imply `jobs`.)
- **napi rebuild:** Task 1 adds the `hash_media_source` napi method, which regenerates `apps/desktop/native/index.d.ts` (gitignored, built locally). Run `npm --prefix apps/desktop run napi:build` at the end of Task 1, BEFORE the Task 2 TS typecheck that calls `backend.hashMediaSource`. **Close the app first** — the running `weftcut-core.*.node` is file-locked on Windows. Tasks 2–4 introduce **no** napi signature changes (`enqueue_jobs_for_media`, `probe_media`, `enqueue_workspace_copy` keep their signatures; `read_mirror_handle` is internal `pub(crate)`, not napi) — no further rebuild needed.
- **Phase ordering is load-bearing.** Task 2 (TS hash-first) MUST land before Task 3 (Rust deletion of the pending/migrate/fresh machinery). After Task 2 the derivatives are already enqueued with the real hash, which turns the still-present `migrate_hash_artifacts` + `patch_…` into harmless no-ops; only then is Task 3 safe to delete them. Reversing the order leaves derivatives keyed on `pending-{id}` with no migration → orphaned artifacts.
- Do NOT touch `read_mirror` (the field) / `set_project_mirror` / `snapshot_for_read` / `mirror_history_view` / `ReadMirror` (the struct) / the per-commit `pushMirror` push — that is **Phase 5**. Phase 4 only removes the last *reader* of the mirror **handle** (`read_mirror_handle`, the jobs/enqueue path) and deletes `read_mirror_handle` itself. After Phase 4 the `read_mirror` field is written by `set_project_mirror` and read only by the two already-`#[allow(dead_code)]` fns — it still compiles.
- `set_media_hash` is a TS-actor-only mutation (the Rust actor was deleted in the state-actor migration). It is **UNRECORDED** (durable across undo, no undo entry, one broadcast id) — the exact pattern of its siblings `set_media_derivatives` / `set_media_workspace_paths` (`actor.ts`). It does **not** go into `replay.ts` `SUPPORTED_OPS` (that set is the differential-test corpus vocabulary; the corpus never emits `set_media_hash`).
- Commit after each task. Stage by **explicit path** (other sessions edit this checkout concurrently — re-check `git status` before each commit).
- End every task green on `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud` (Rust tasks) and `npm --prefix apps/desktop run typecheck` + `npm --prefix apps/desktop test` (TS tasks).

---

## File Structure

- `apps/desktop/native/src/napi_backend.rs` — Task 1: add `hash_media_source` napi (additive). Task 3: `ImportQueue::new` no longer takes the mirror; `enqueue_jobs_for_media` drops the `read_mirror_handle()` arg; **delete** `read_mirror_handle`; extend the source-guard with a jobs-path-mirror-free assertion.
- `apps/desktop/native/src/commands/media.rs` — Task 3: `probe_media_item` becomes stat-only always (drops the `has_workspace` param + the hash branch); `ensure_full_proxy` / `ensure_conform` drop the `read_mirror_handle()` arg. The `probe_media` napi (in `napi_backend.rs`) drops its `has_workspace` computation.
- `apps/desktop/native/src/commands/export.rs` — Task 3: `ensure_export_audio_conform` drops the `read_mirror_handle()` arg.
- `apps/desktop/native/src/jobs/mod.rs` — Task 3: drop the `mirror` param from `enqueue_full_proxy` / `enqueue_for_media` / `enqueue_conform` / `spawn_*`; delete `fresh_media_item` + its test.
- `apps/desktop/native/src/jobs/import.rs` — Task 3: delete `pending_hash_for`, `rewrite_hash_in_path`, `patch_derivative_paths_after_hash_migration`, the `migrate_hash_artifacts` call; drop the `mirror` field from `ImportQueue`; rewrite the file header; delete the three dead tests.
- `apps/desktop/native/src/cache/mod.rs` — Task 3: delete `migrate_hash_artifacts` + its two tests (no other caller).
- `apps/desktop/src/main/state/mutations/media.ts` — Task 2: add `applySetMediaHash`.
- `apps/desktop/src/main/state/actor.ts` — Task 2: add `setMediaHash` + the `set_media_hash` dispatch arm; import `applySetMediaHash`.
- `apps/desktop/src/main/state/hybrids.ts` — Task 2: add `hashMediaSource` to `ComputeNapi`; rework the `import_media` arm to hash-first.
- `apps/desktop/src/main/index.ts` — Task 2: add `hashMediaSource` to `computeFacade`.
- `apps/desktop/src/main/state/__tests__/hybrids.test.ts` — Task 2: add the `hashMediaSource` mock; rework the `import_media` tests (the Phase-4 regression: real hash baked before enqueue, `set_media_hash` updates the pool).
- `apps/desktop/src/main/state/actor.test.ts` — Task 2: add a `set_media_hash` unit test.
- ComputeNapi test stubs (Task 2, mechanical — add `hashMediaSource`): `ts-actor-host.test.ts`, `mcp/server.flip.test.ts`, `__tests__/agent-session-end.test.ts`, `__tests__/mcp.malformed-args.test.ts`, `__tests__/mirror-push.test.ts`, `__tests__/restore-log-parity.test.ts`.
- `docs/adr/0007-derivative-jobs-run-against-a-pending-hash.md` — Task 4: status → superseded + banner.
- `docs/data-model.md` — Task 4: rewrite the pending-hash paragraph (`:198-200`) to hash-first.

---

## Task 1: Rust — add the `hash_media_source` napi (additive) + unit test + napi rebuild

A standalone, stateless BLAKE3 pass over a source file — the "lightweight hash step" the spec calls for. Pure compute (path → hex); reuses `io::probe::hash_and_stat` (DRY). Additive only: nothing calls it yet, so this task is independently mergeable and leaves both build + suite green. Adding the method regenerates `index.d.ts`, which Task 2's typecheck depends on.

**Files:**
- Modify: `apps/desktop/native/src/napi_backend.rs` (add the method next to `probe_media`, `:237-245`; add a test in the `tests` module)

**Interfaces:**
- Produces: `hash_media_source(&self, path: String) -> napi::Result<String>` (napi; regenerates `hashMediaSource(path: string): Promise<string>` in `index.d.ts`) — returns the source file's BLAKE3 hex.

- [ ] **Step 1: Write the failing unit test.** In `apps/desktop/native/src/napi_backend.rs`, find the `#[cfg(test)] mod tests` block and add this test (place it near the other `Backend`-construction tests):

```rust
    /// hash_media_source returns the BLAKE3 hex of the file's bytes — the
    /// standalone hash pass the import hybrid runs before enqueuing derivatives
    /// (stateless-compute Phase 4). Asserts against blake3's known hash of the
    /// content so the value, not just non-emptiness, is pinned.
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hash_media_source_returns_blake3_of_file() {
        let sink = std::sync::Arc::new(crate::events::VecEventSink::new());
        let b = Backend::new_for_test(sink as std::sync::Arc<dyn crate::events::EventSink>);
        let dir = std::env::temp_dir().join(format!("weftcut-hashsrc-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("clip.bin");
        std::fs::write(&f, b"hello weftcut").unwrap();

        let got = b.hash_media_source(f.to_string_lossy().to_string()).await.unwrap();
        let want = blake3::hash(b"hello weftcut").to_hex().to_string();
        assert_eq!(got, want, "hash_media_source must return the blake3 hex of the file bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run it — verify it fails to compile.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud --no-run`
Expected: FAIL — `no method named hash_media_source found for struct Backend`.

- [ ] **Step 3: Add the napi method.** In `apps/desktop/native/src/napi_backend.rs`, immediately after the `probe_media` method (ends at `:245`, inside the `#[cfg(feature = "jobs")]`-adjacent `#[napi] impl Backend` block — `probe_media` itself carries `#[cfg(feature = "jobs")]`), add:

```rust
    /// Standalone BLAKE3 hash of a source file — the "lightweight hash step" of
    /// the hash-first import (stateless-compute Phase 4). The probe is stat-only
    /// (instant timeline appearance) and the item carries a provisional hash; the
    /// TS host runs this pass next, sets the real hash, THEN enqueues derivatives,
    /// so jobs bake the final cache key and never touch a pending alias. Pure
    /// compute (path → hex); reuses io::probe::hash_and_stat. spawn_blocking — the
    /// full read is blocking I/O.
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn hash_media_source(&self, path: String) -> napi::Result<String> {
        let buf = std::path::PathBuf::from(&path);
        let facts = tokio::task::spawn_blocking(move || crate::io::probe::hash_and_stat(&buf))
            .await
            .map_err(|e| Error::from_reason(format!("hash join: {e}")))?
            .map_err(|e| Error::from_reason(format!("{e:#}")))?;
        Ok(facts.blake3_hex)
    }
```

- [ ] **Step 4: Run the test — verify it passes.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud hash_media_source_returns_blake3_of_file`
Expected: PASS.

- [ ] **Step 5: Full native suite (must be green).** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed.

- [ ] **Step 6: Rebuild the napi addon (regenerate `index.d.ts`).** Close the app if running (the `.node` is file-locked). Run: `npm --prefix apps/desktop run napi:build`
Expected: build succeeds. Verify: `rg -n hashMediaSource apps/desktop/native/index.d.ts` shows `hashMediaSource(path: string): Promise<string>`.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/native/src/napi_backend.rs
git commit -m "feat(stateless): add hash_media_source napi (standalone blake3 pass for hash-first import)"
```

---

## Task 2: TS — hash-first import orchestration (`set_media_hash` + reworked `import_media`)

The import hybrid stops inserting against a deferred hash. It probes stat-only (clip appears instantly), runs the standalone hash pass, sets the real hash on the pool item via the new `set_media_hash` mutation, and only THEN enqueues derivatives with the real-hash item baked in. The workspace copy still runs in parallel; with the real hash already set, the Rust copy's `migrate_hash_artifacts` + `patch_…` (still present until Task 3) find nothing to rename/rewrite — harmless no-ops. **This is the load-bearing task: it must land before Task 3.**

**Files:**
- Modify: `apps/desktop/src/main/state/mutations/media.ts` (add `applySetMediaHash` after `applySetMediaWorkspacePaths`, `:90`)
- Modify: `apps/desktop/src/main/state/actor.ts` (add `setMediaHash` after `setMediaWorkspacePaths` `:284`; add the dispatch arm after `set_media_workspace_paths` `:448`; extend the `applySet…` import)
- Modify: `apps/desktop/src/main/state/hybrids.ts` (add `hashMediaSource` to `ComputeNapi` `:21`; import `MediaItem`; rework the `import_media` arm `:89-115`)
- Modify: `apps/desktop/src/main/index.ts` (add `hashMediaSource` to `computeFacade` `:278-282`)
- Modify (test): `apps/desktop/src/main/state/__tests__/hybrids.test.ts`, `apps/desktop/src/main/state/actor.test.ts`
- Modify (stubs): `apps/desktop/src/main/state/ts-actor-host.test.ts`, `apps/desktop/src/main/mcp/server.flip.test.ts`, `apps/desktop/src/main/state/__tests__/agent-session-end.test.ts`, `apps/desktop/src/main/state/__tests__/mcp.malformed-args.test.ts`, `apps/desktop/src/main/state/__tests__/mirror-push.test.ts`, `apps/desktop/src/main/state/__tests__/restore-log-parity.test.ts`

**Interfaces:**
- Consumes: `ComputeNapi.hashMediaSource(path)` (Task 1 napi via `computeFacade`); `actor.dispatch('add_media_item' | 'set_media_hash', …)`; `deps.enqueueDerivatives` / `deps.enqueueWorkspaceCopy` / `deps.workspaceDir` (existing `HybridDeps`).
- Produces: `applySetMediaHash(pool, id, hash): Record<string, MediaItem>` (mutations/media.ts); the `set_media_hash` actor command (`{ media, file_hash_blake3 }` → unrecorded pool update); `ComputeNapi.hashMediaSource(path: string): Promise<string>`.

- [ ] **Step 1: Write the failing `set_media_hash` mutation test.** In `apps/desktop/src/main/state/actor.test.ts`, add a new `describe` (or a test inside an existing media-mutation `describe`), using the file's standard inline construction idiom (`seededGen` / `blankProject` / `createActor` are already imported and used throughout):

```ts
  it('set_media_hash replaces the pool item hash (unrecorded); MediaNotFound for absent id', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'mh')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const add = actor.dispatch('add_media', { id: 'm-hash', kind: 'Video', duration_us: 1_000_000 })
    expect(add.ok).toBe(true)
    const r = actor.dispatch('set_media_hash', { media: 'm-hash', file_hash_blake3: 'realhash-abc' })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().media_pool['m-hash'].file_hash_blake3).toBe('realhash-abc')
    // MediaNotFound for an absent id (dispatch returns ok:false, not a throw).
    expect(actor.dispatch('set_media_hash', { media: 'nope', file_hash_blake3: 'x' }).ok).toBe(false)
  })
```

- [ ] **Step 2: Run it — verify it fails.** Run: `npm --prefix apps/desktop test -- actor.test`
Expected: FAIL — `set_media_hash` is an unhandled command (dispatch returns `ok:false` with an unknown-command error, so the first `expect(r.ok).toBe(true)` fails).

- [ ] **Step 3: Add `applySetMediaHash`.** In `apps/desktop/src/main/state/mutations/media.ts`, after `applySetMediaWorkspacePaths` (`:90`), add:

```ts
/** Set ONLY the source content hash on a pool item — used by the hash-first
 *  import (stateless-compute Phase 4): the standalone BLAKE3 pass result replaces
 *  the provisional probe hash BEFORE any derivative job is enqueued. UNRECORDED,
 *  no validation (mirrors the sibling setters). MediaNotFound if absent. */
export function applySetMediaHash(pool: Record<string, MediaItem>, id: Uuid, hash: string): Record<string, MediaItem> {
  const item = pool[id]
  if (!item) throw new CommandFailure({ error: 'MediaNotFound', media: id })
  return { ...pool, [id]: { ...item, file_hash_blake3: hash } }
}
```

- [ ] **Step 4: Add the actor command.** In `apps/desktop/src/main/state/actor.ts`:

(a) Extend the mutations/media import to include `applySetMediaHash`. Find the existing import that pulls in `applySetMediaDerivatives` / `applySetMediaWorkspacePaths` and add `applySetMediaHash` to its named list.

(b) Add the `setMediaHash` fn just after `setMediaWorkspacePaths` (`:281-285`):

```ts
  // ── set_media_hash — UNRECORDED. Hash-first import (stateless-compute Phase 4):
  //    the standalone BLAKE3 pass sets the real source hash on the pool item
  //    before derivatives enqueue. Durable across undo (a content fact, not an
  //    edit). MediaNotFound first (no id); else patch + replace EVERYWHERE. ──
  function setMediaHash(id: Uuid, hash: string): void {
    const nextPool = applySetMediaHash(current().media_pool, id, hash) // throws MediaNotFound
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Updated media hash', current())
  }
```

(c) Add the dispatch arm immediately after the `set_media_workspace_paths` case (`:448`):

```ts
        case 'set_media_hash': setMediaHash(a.media as Uuid, a.file_hash_blake3 as string); return { ok: true, value: null }
```

- [ ] **Step 5: Run the mutation test — verify it passes.** Run: `npm --prefix apps/desktop test -- actor.test`
Expected: PASS.

- [ ] **Step 6: Add `hashMediaSource` to `ComputeNapi` + the production facade.** In `apps/desktop/src/main/state/hybrids.ts`, add the field to the `ComputeNapi` interface (after `probeMedia`, `:17`):

```ts
  /** Standalone BLAKE3 of a source file — the hash-first import's hash pass
   *  (stateless-compute Phase 4). Run AFTER the stat-only probe + insert, BEFORE
   *  derivative enqueue, so jobs bake the real cache key. (Backend.hashMediaSource) */
  hashMediaSource(path: string): Promise<string>
```

In `apps/desktop/src/main/index.ts`, add the facade method to `computeFacade` (`:278-282`):

```ts
    hashMediaSource: (p: string) => backend!.hashMediaSource(p),
```

- [ ] **Step 7: Update the failing import_media hybrid tests (the Phase-4 regression).** In `apps/desktop/src/main/state/__tests__/hybrids.test.ts`:

(a) In `makeDeps`, add a `hashMediaSource` mock alongside `probeMedia`. Add the fake + the spy export. The fake returns a fixed sentinel real hash:

```ts
  const probeMedia = vi.fn(async () => JSON.stringify(probedItem()))
  const hashMediaSource = vi.fn(async () => 'realhash-deadbeef')
```

In the `compute:` object literal add `hashMediaSource,` next to `probeMedia,`. In the return `Object.assign(deps, { … })`, add `_hashMediaSource: hashMediaSource,`. Add `_hashMediaSource: ReturnType<typeof vi.fn>` to `makeDeps`' return type annotation.

(b) Update the existing `import_media` assertions so they reflect the baked real hash and add the regression cases. Replace the `kicks derivative jobs with the probed item` test and add two new ones:

```ts
  it('kicks derivative jobs with the REAL-hash item (hash-first, not the provisional probe hash)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(deps._hashMediaSource).toHaveBeenCalledWith('C:/x.mp4')
    expect(deps._enqueueDerivatives).toHaveBeenCalledTimes(1)
    const arg = deps._enqueueDerivatives.mock.calls[0][0] as MediaItem[]
    expect(arg).toHaveLength(1)
    expect(arg[0].id).toBe(MID)
    // The provisional probe hash ('0' from probedItem) must NEVER reach enqueue —
    // derivatives bake the real content hash (ADR 0007 superseded).
    expect(arg[0].file_hash_blake3).toBe('realhash-deadbeef')
  })

  it('sets the real content hash on the pool item before returning', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(actor.snapshot().media_pool[MID].file_hash_blake3).toBe('realhash-deadbeef')
  })

  it('inserts the item BEFORE hashing (instant appearance), then hashes', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    const order: string[] = []
    deps._probeMedia.mockImplementation(async () => { order.push('probe'); return JSON.stringify(probedItem()) })
    deps._hashMediaSource.mockImplementation(async () => { order.push('hash'); return 'realhash-deadbeef' })
    deps._enqueueDerivatives.mockImplementation(async () => { order.push('enqueue') })
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    // probe (stat-only) → hash pass → enqueue: the real hash is known before any job.
    expect(order).toEqual(['probe', 'hash', 'enqueue'])
  })
```

(The `returns the new media id and inserts the probed item`, `enqueues the workspace copy when a workspace exists`, `does NOT enqueue …`, the subtitle-branch, and the `throws when the actor rejects the insert` tests are unaffected — leave them. If `throws when the actor rejects the insert` mocks `probeMedia` to a bad item, the `add_media_item` `!r.ok` throw still fires before the hash pass, so it stays valid.)

- [ ] **Step 8: Rework the `import_media` arm.** In `apps/desktop/src/main/state/hybrids.ts`:

(a) Add the model import near the top (after the `ActorHandle` import, `:10`):

```ts
import type { MediaItem } from './model'
```

(b) Replace the `import_media` arm body (`:89-115`, from `case 'import_media': {` through its closing `}` before `case 'apply_subtitles'`) with:

```ts
    case 'import_media': {
      const path = args.path as string
      // Subtitles are CONSUMED into a caption track (not pooled). Read the file,
      // derive a label, hand off to applySubtitleBody, return the BARE track id
      // (flag-off parity — media.rs returns Ok(track_id), discards `simplified`).
      if (/\.(srt|ass|vtt)$/i.test(path)) {
        const body = deps.readFile(path)
        const label = path.replace(/\\/g, '/').split('/').pop() ?? null
        return (await applySubtitleBody(body, null, label, deps)).track_id
      }
      // Hash-first import (stateless-compute Phase 4). probeMedia is stat-only, so
      // the item carries a PROVISIONAL hash; insert it first so the clip appears in
      // the timeline immediately.
      const item = JSON.parse(await deps.compute.probeMedia(path)) as MediaItem
      const r = deps.actor.dispatch('add_media_item', { media: item })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      // Compute the REAL content hash (a lightweight standalone read pass), set it
      // on the pool item, THEN enqueue derivatives — so every job bakes the final
      // cache key and no derivative ever touches a pending alias (ADR 0007
      // superseded). One extra full read of the source, accepted to start
      // derivatives promptly instead of waiting for the workspace copy.
      const hash = await deps.compute.hashMediaSource(path)
      const hr = deps.actor.dispatch('set_media_hash', { media: item.id, file_hash_blake3: hash })
      // Benign if the media was removed during hashing — nothing left to enqueue.
      if (!hr.ok) return item.id
      const hashedItem: MediaItem = { ...item, file_hash_blake3: hash }
      // Derivative jobs read the SOURCE (hashedItem.path_abs is still the original);
      // content-addressed by the real hash, so source vs the workspace copy is
      // equivalent.
      await deps.enqueueDerivatives([hashedItem])
      // Workspace copy runs in PARALLEL: copies the source into <workspace>/Media,
      // re-confirms the same hash, and flips path_abs via the media:workspace_paths
      // seam. No-op napi when no workspace.
      if (deps.workspaceDir()) await deps.enqueueWorkspaceCopy(item.id, path)
      return item.id
    }
```

- [ ] **Step 9: Add `hashMediaSource` to the six ComputeNapi test stubs (mechanical).** Each of these builds a `compute` object that must now satisfy `ComputeNapi`. Add `hashMediaSource: async () => 'h'` (or `vi.fn(async () => 'h')` where the others use `vi.fn`) next to the existing `synthesizeSpeechCompute`:
  - `apps/desktop/src/main/state/ts-actor-host.test.ts:64` — `compute: { probeMedia: …, parseSubtitles: …, synthesizeSpeechCompute: async () => '{}', hashMediaSource: async () => 'h' }`
  - `apps/desktop/src/main/state/__tests__/agent-session-end.test.ts:13` — same shape
  - `apps/desktop/src/main/state/__tests__/mcp.malformed-args.test.ts:16` — same shape
  - `apps/desktop/src/main/state/__tests__/mirror-push.test.ts:10` — same shape
  - `apps/desktop/src/main/state/__tests__/restore-log-parity.test.ts:39` — same shape
  - `apps/desktop/src/main/mcp/server.flip.test.ts:17-18` — uses `vi.fn`: add `hashMediaSource: vi.fn(async () => 'h'),`

- [ ] **Step 10: Run the reworked hybrid tests — verify they pass.** Run: `npm --prefix apps/desktop test -- hybrids.test`
Expected: PASS (including the three new regression cases).

- [ ] **Step 11: Typecheck + full TS suite (must be green).** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean (the regenerated `index.d.ts` from Task 1 Step 6 has `hashMediaSource`; if typecheck reports `Property 'hashMediaSource' does not exist` on the backend, Task 1's `napi:build` did not run / did not regenerate — re-run it). All tests pass.

- [ ] **Step 12: Commit.**

```bash
git add apps/desktop/src/main/state/mutations/media.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/src/main/state/hybrids.ts apps/desktop/src/main/index.ts apps/desktop/src/main/state/__tests__/hybrids.test.ts apps/desktop/src/main/state/ts-actor-host.test.ts apps/desktop/src/main/mcp/server.flip.test.ts apps/desktop/src/main/state/__tests__/agent-session-end.test.ts apps/desktop/src/main/state/__tests__/mcp.malformed-args.test.ts apps/desktop/src/main/state/__tests__/mirror-push.test.ts apps/desktop/src/main/state/__tests__/restore-log-parity.test.ts
git commit -m "refactor(stateless): hash-first import — set real hash before derivative enqueue (set_media_hash)"
```

---

## Task 3: Rust — delete the pending/migrate/fresh-media-item/mirror-handle machinery + probe stat-only

With Task 2 baking the real hash before enqueue, the `pending-{id}` alias, the copy-time migrate/patch, and the per-job `fresh_media_item` re-read are all dead weight. Delete them and drop the `mirror` handle from the entire jobs/enqueue path; `read_mirror_handle` then has no callers and is deleted too (the mirror struct/field/push survive until Phase 5). `probe_media_item` becomes unconditionally stat-only.

**Files:**
- Modify: `apps/desktop/native/src/jobs/mod.rs` (`:179-186`, `:190-243`, `:245-250`, `:324-329`, `:503-509`, `:577-583`, `:586-591`, `:608`, `:670` unaffected; delete `fresh_media_item` `:741-754` + its test `:797-866`)
- Modify: `apps/desktop/native/src/jobs/import.rs` (header `:1-26`; `use` `:41,44,46`; `ImportQueue` field `:84-86`; `new` `:108-125`; worker success arm `:272-322`; delete `pending_hash_for` `:420-422`, `rewrite_hash_in_path` `:424-431`, `patch_derivative_paths_after_hash_migration` `:433-503`; delete tests `:655-672`)
- Modify: `apps/desktop/native/src/cache/mod.rs` (delete `migrate_hash_artifacts` `:236-294` + tests `:426-454`)
- Modify: `apps/desktop/native/src/napi_backend.rs` (`build_backend` `:70-76`; `enqueue_jobs_for_media` `:224`; `probe_media` `:237-244`; delete `read_mirror_handle` `:388-392`; extend the guard `:840-919`)
- Modify: `apps/desktop/native/src/commands/media.rs` (`probe_media_item` `:18-50`; `ensure_full_proxy` `:118`; `ensure_conform` `:129`)
- Modify: `apps/desktop/native/src/commands/export.rs` (`ensure_export_audio_conform` `:117-122`)

**Interfaces:**
- Produces: `enqueue_full_proxy(events, cache, media)`, `enqueue_for_media(events, cache, media)`, `enqueue_conform(events, cache, media)` (mirror param dropped); `probe_media_item(source_buf: PathBuf) -> Result<MediaItem, String>` (stat-only, no `has_workspace`). `read_mirror_handle` removed.

- [ ] **Step 1: Drop the `mirror` param across the jobs fan-out + delete `fresh_media_item`.** In `apps/desktop/native/src/jobs/mod.rs`:

(a) Remove the `mirror: std::sync::Arc<std::sync::Mutex<Option<crate::napi_backend::ReadMirror>>>,` parameter from each of: `enqueue_full_proxy`, `enqueue_for_media`, `enqueue_conform`, `spawn_conform`, `spawn_proxy_decision`, `spawn_decorations`, `spawn_quick_proxy`, `spawn_proxy`. Update each call site to drop the trailing `mirror` / `mirror.clone()` arg:
  - `enqueue_full_proxy` body: `spawn_proxy(events, cache, media);`
  - `enqueue_for_media` body: `spawn_decorations(events, cache, media);` / `spawn_proxy_decision(events, cache, media);` and the `MediaKind::Audio` arm `spawn_conform(events, cache, media);`
  - `spawn_decorations` body: `spawn_conform(events, cache, media);`
  - `enqueue_conform` body: `spawn_conform(events, cache, media);`
  - `spawn_proxy_decision` body: the three `spawn_decorations(...)` / `spawn_quick_proxy(...)` / `spawn_quick_proxy(...)` calls drop their trailing `mirror*` arg.
  - `spawn_quick_proxy` body: drop its trailing `mirror` arg on the `spawn_proxy(events, cache, media)` call in the `then_full` branch.
  - `spawn_proxy` body: `spawn_decorations(events, cache, thumbnail_media);`

(b) In each of `spawn_conform`, `spawn_quick_proxy`, `spawn_proxy`, **delete** the line `let media = fresh_media_item(&mirror, media_id, media).await;` (the job uses the passed-in `media` directly — its hash is real, baked at enqueue). In `spawn_quick_proxy`'s `then_full` branch, delete the `let media = fresh_media_item(&mirror, media_id, media).await;` line that precedes `spawn_proxy`.

(c) Delete the `fresh_media_item` fn (`:741-754`) and its test `fresh_media_item_reads_mirror` (`:797-866`) in the `tests` module.

- [ ] **Step 2: Drop the `read_mirror_handle()` args at the three command call sites.** 
  - `apps/desktop/native/src/commands/media.rs`: `ensure_full_proxy` → `crate::jobs::enqueue_full_proxy(backend.events.clone(), backend.cache.clone(), item);` and `ensure_conform` → `crate::jobs::enqueue_conform(backend.events.clone(), backend.cache.clone(), item);`
  - `apps/desktop/native/src/commands/export.rs`: in `ensure_export_audio_conform`, the `enqueue_conform(...)` call drops the `backend.read_mirror_handle(),` line → `crate::jobs::enqueue_conform(backend.events.clone(), backend.cache.clone(), item);`
  - `apps/desktop/native/src/napi_backend.rs`: `enqueue_jobs_for_media` (`:224`) → `crate::jobs::enqueue_for_media(self.events.clone(), self.cache.clone(), item);`

- [ ] **Step 3: Make `probe_media_item` stat-only always.** In `apps/desktop/native/src/commands/media.rs`, replace `probe_media_item` (`:12-50`) with:

```rust
/// Probe a source file into a `MediaItem` (no actor write). Stat-only +
/// metadata probe + kind detection — NO blake3 (instant timeline appearance).
/// `file_hash_blake3` is a PROVISIONAL sentinel (`pending-{id}`) that is never
/// used as a cache key: the TS host runs the standalone `hash_media_source` pass
/// and sets the real hash via `set_media_hash` BEFORE enqueuing any derivative
/// (stateless-compute Phase 4 — ADR 0007 superseded). Mints the media id
/// internally. The `probe_media` napi reuses this exact body.
pub fn probe_media_item(source_buf: PathBuf) -> Result<MediaItem, String> {
    let media_id = uuid::Uuid::new_v4();
    let (file_size, file_mtime) = io::probe::stat_file(&source_buf).map_err(|e| format!("{e:#}"))?;
    let metadata = io::probe::probe_metadata(&source_buf);
    let kind: MediaKind = io::probe::detect_kind(&source_buf, &metadata);
    let label = source_buf.file_name().map(|n| n.to_string_lossy().to_string());
    Ok(MediaItem {
        id: media_id,
        label,
        path_abs: source_buf,
        path_rel: None,
        kind,
        metadata,
        proxy_path: None,
        proxy_format_version: 0,
        quick_proxy_path: None,
        proxy_bypassed: false,
        export_uses_original: false,
        waveform_path: None,
        conform_path: None,
        thumbnails_dir: None,
        file_hash_blake3: format!("pending-{media_id}"),
        file_size,
        file_mtime,
        imported_at: Utc::now(),
    })
}
```

Then in `apps/desktop/native/src/napi_backend.rs` `probe_media` (`:237-244`), delete the `let has_workspace = self.workspace.current().is_some();` line and change the spawn_blocking call to `crate::commands::media::probe_media_item(buf)`.

- [ ] **Step 4: Delete the import-copy migrate/patch/pending machinery.** In `apps/desktop/native/src/jobs/import.rs`:

(a) Rewrite the file header doc comment (`:1-26`) to describe the hash-first flow. Replace the numbered list with:

```rust
//! Background-copy import worker.
//!
//! The import hybrid (TS `hybrids.ts` `import_media`) computes the real BLAKE3
//! content hash BEFORE enqueuing derivative jobs (stateless-compute Phase 4), so
//! every derivative is keyed on the final content hash from the start. This
//! worker only copies the source into `<workspace>/Media/<filename>` (hash-prefix
//! collision handling), then routes the path/hash result through the
//! `media:workspace_paths` seam (`commit_media_workspace_paths`) for the TS actor
//! (the sole writer) to flip `path_abs` to the workspace copy and populate
//! `path_rel`. Derivative jobs read the source until the copy lands; because they
//! are content-addressed, source vs the workspace copy is equivalent.
//!
//! napi events surface progress to the UI:
//!   - `import:queue`    → full list, on every state change
//!   - `import:started`  → media_id, when copy begins
//!   - `import:complete` → media_id + path_rel, on success
//!   - `import:error`    → media_id + detail, on failure
//!
//! Single-worker FIFO — disk write bandwidth is the bottleneck. Cancellation
//! between jobs drops a pending job + its MediaItem; mid-copy cancellation is
//! best-effort via a shared atomic flag the chunked copy checks per buffer.
```

(b) Fix the `use` block: remove `use crate::napi_backend::ReadMirror;` (`:44`); change `use crate::cache::{self, CacheLayout};` (`:41`) to `use crate::cache::CacheLayout;`; remove `use crate::state::MediaDerivativesPatch;` (`:46`) — it was only used by the deleted patch fn. (Keep `use crate::state::ids::MediaId;`.)

(c) Remove the `mirror` field from `ImportQueue` (`:84-86`, the field + its doc comment) and from `ImportQueue::new` — delete the `mirror: Arc<Mutex<Option<ReadMirror>>>,` param (`:112`) and the `mirror,` initializer (`:123`). `new` now takes `(events, log_slot)`.

(d) In `worker_loop`, replace the `Ok(Some(copy)) => { … }` success arm (`:272-355`) so it drops the pending-hash + migrate + patch. The new arm:

```rust
                Ok(Some(copy)) => {
                    let dest_abs = next.workspace_root.join(&copy.dest_rel);
                    // Route the path/hash write-back through the shared seam: it
                    // emits `media:workspace_paths` for the TS host to apply (the
                    // sole writer). The hash matches the standalone hash pass the
                    // import already ran (same bytes), so this is idempotent — no
                    // migrate/patch needed (hash-first; ADR 0007 superseded).
                    if let Err(e) = crate::jobs::commit_media_workspace_paths(
                        &self.events,
                        media_id,
                        dest_abs.clone(),
                        copy.dest_rel.clone(),
                        copy.facts.blake3_hex.clone(),
                        copy.facts.size,
                        copy.facts.mtime_secs,
                    )
                    .await
                    {
                        warn!("import: actor update failed: {e}");
                        self.finalize(media_id, ImportStatus::Failed { detail: e.to_string() });
                        self.events.emit(
                            events::ERROR,
                            serde_json::json!({ "mediaId": media_id.to_string(), "detail": e.to_string() }),
                        );
                        self.log_slot.emit(logs::LogEntryInput {
                            level: logs::LogLevel::Error,
                            category: logs::LogCategory::Import,
                            source: logs::LogSource::User,
                            message: format!("Import failed: {e}"),
                            op_id: Some(log_op_id),
                            op_state: Some(logs::OpState::Err),
                            ..Default::default()
                        });
                    } else {
                        info!("import: {} -> {}", next.source.display(), copy.dest_rel.display());
                        self.finalize_with_dest(
                            media_id,
                            ImportStatus::Completed,
                            Some(copy.dest_rel.to_string_lossy().to_string()),
                        );
                        self.events.emit(
                            events::COMPLETE,
                            serde_json::json!({ "mediaId": media_id.to_string(), "pathRel": copy.dest_rel.to_string_lossy() }),
                        );
                        self.log_slot.emit(logs::LogEntryInput {
                            level: logs::LogLevel::Info,
                            category: logs::LogCategory::Import,
                            source: logs::LogSource::User,
                            message: format!("Imported {} → {}", next.source.display(), copy.dest_rel.display()),
                            op_id: Some(log_op_id),
                            op_state: Some(logs::OpState::Ok),
                            ..Default::default()
                        });
                    }
                }
```

(e) Delete `pending_hash_for` (`:420-422`), `rewrite_hash_in_path` (`:424-431`), and `patch_derivative_paths_after_hash_migration` (`:433-503`).

(f) Delete the three now-orphaned tests in the `tests` module: `pending_hash_is_media_id_prefixed`, `rewrite_hash_replaces_pending_token`, `rewrite_hash_returns_none_when_token_absent` (`:655-672`). Keep `pick_dest_filename_*` and the two `copy_to_workspace_*` tests.

- [ ] **Step 5: Update `ImportQueue::new` construction.** In `apps/desktop/native/src/napi_backend.rs` `build_backend` (`:70-76`), update the comment + the constructor call. Replace:

```rust
    // The TS read-mirror is the sole project source; the import queue reads it
    // to rewrite `pending-` derivative paths, so share the one Arc.
    let read_mirror: std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    #[cfg(feature = "jobs")]
    let import_queue =
        crate::jobs::import::ImportQueue::new(events.clone(), log_slot.clone(), read_mirror.clone());
```

with:

```rust
    // The TS read-mirror is written by set_project_mirror; no Rust read path
    // consumes it after Phase 4 (deleted wholesale in Phase 5).
    let read_mirror: std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    #[cfg(feature = "jobs")]
    let import_queue = crate::jobs::import::ImportQueue::new(events.clone(), log_slot.clone());
```

- [ ] **Step 6: Delete `read_mirror_handle`.** In `apps/desktop/native/src/napi_backend.rs`, delete the `read_mirror_handle` fn (`:388-392`, including its doc comment). (`snapshot_for_read` + `mirror_history_view` STAY — they keep their `#[allow(dead_code)]` until Phase 5.)

- [ ] **Step 7: Delete `migrate_hash_artifacts`.** In `apps/desktop/native/src/cache/mod.rs`, delete the `migrate_hash_artifacts` fn (`:236-294`) and its two tests `migrate_hash_artifacts_renames_proxy_and_waveform` + `migrate_hash_artifacts_noop_for_same_hash` (`:426-454`).

- [ ] **Step 8: Extend the source-guard with a jobs-path-mirror-free assertion.** In `apps/desktop/native/src/napi_backend.rs`, inside `mirror_backed_reads_use_the_mirror_not_an_actor` (`:840-919`), after the existing `media` / `export` reads, add reads + assertions for the jobs path. After the `let resources = …` read block, add:

```rust
        let jobs_mod = std::fs::read_to_string(format!("{root}/src/jobs/mod.rs"))
            .expect("jobs/mod.rs must be readable");
        let jobs_import = std::fs::read_to_string(format!("{root}/src/jobs/import.rs"))
            .expect("jobs/import.rs must be readable");
```

and, after the `mcp/resources.rs` assert block, add:

```rust
        // Phase 4 (stateless-compute-service): the import / derivative-jobs path is
        // mirror-free — the hash-first import bakes the real content hash into the
        // enqueued MediaItem, so no job re-reads the mirror (fresh_media_item gone)
        // and the workspace copy no longer migrates a pending alias. `read_mirror_handle`
        // is deleted; only `set_project_mirror` + the two dead-code readers remain
        // (deleted in Phase 5).
        for (name, src) in [
            ("commands/media.rs", &media),
            ("commands/export.rs", &export),
            ("jobs/mod.rs", &jobs_mod),
            ("jobs/import.rs", &jobs_import),
        ] {
            assert!(
                !src.contains("read_mirror_handle") && !src.contains("fresh_media_item"),
                "{name}: the jobs/enqueue path must be mirror-free (no read_mirror_handle / fresh_media_item) — hash-first import (Phase 4)"
            );
        }
        assert!(
            !jobs_import.contains("migrate_hash_artifacts") && !jobs_import.contains("pending_hash_for"),
            "jobs/import.rs: the pending-hash / migrate machinery is deleted (Phase 4)"
        );
```

- [ ] **Step 9: Full native suite (must be green before commit).** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed. No dead-code warnings (the `mirror`-param removals + deletions leave no unused imports — if a warning fires for an unused `use`, remove it). The extended guard passes.

- [ ] **Step 10: Commit.**

```bash
git add apps/desktop/native/src/jobs/mod.rs apps/desktop/native/src/jobs/import.rs apps/desktop/native/src/cache/mod.rs apps/desktop/native/src/napi_backend.rs apps/desktop/native/src/commands/media.rs apps/desktop/native/src/commands/export.rs
git commit -m "refactor(stateless): drop pending-hash/migrate/fresh-media-item + read_mirror_handle (hash-first jobs path)"
```

---

## Task 4: Docs — supersede ADR 0007 + update the data-model import paragraph

The hash-first rework overturns ADR 0007 (the pending-hash decision). Per the evergreen-docs convention, mark the ADR `superseded` with a banner and rewrite the data-model paragraph that still describes the pending flow.

**Files:**
- Modify: `docs/adr/0007-derivative-jobs-run-against-a-pending-hash.md`
- Modify: `docs/data-model.md` (`:198-200`)

- [ ] **Step 1: Supersede ADR 0007.** In `docs/adr/0007-derivative-jobs-run-against-a-pending-hash.md`, change the frontmatter `status: accepted` to `status: superseded` and insert a banner immediately after the frontmatter, before the `#` title:

```markdown
> **Superseded (2026-06-27, stateless-compute-service Phase 4):** The import
> pipeline now computes the real BLAKE3 content hash *before* enqueuing derivative
> jobs (the "hash-first" rework). Jobs bake the final content-hash cache key at
> enqueue time, so the `pending-{media_id}` alias, `cache::migrate_hash_artifacts`,
> `patch_derivative_paths_after_hash_migration`, and the per-job `fresh_media_item`
> re-read are all gone. The clip still appears instantly (a stat-only probe); a
> lightweight standalone hash pass sets the real hash, then derivatives enqueue,
> while the workspace copy runs in parallel. See `docs/data-model.md` (import
> flow). Retained for historical context.
```

- [ ] **Step 2: Rewrite the data-model import paragraph.** In `docs/data-model.md`, replace the paragraph at `:198-200`:

```markdown
Background derivative jobs may start before `file_hash_blake3` is final, keyed
on a temporary `pending-{media_id}` hash that migrates to the content hash when
the import copy finishes (ADR 0007).
```

with:

```markdown
On import the clip appears immediately from a stat-only probe (the item carries
a provisional `file_hash_blake3`); a lightweight standalone BLAKE3 pass then sets
the real content hash before any derivative job is enqueued, so jobs are always
keyed on the final content hash and the workspace copy runs in parallel.
(Supersedes the former pending-hash/migrate scheme, ADR 0007.)
```

- [ ] **Step 3: Commit.**

```bash
git add docs/adr/0007-derivative-jobs-run-against-a-pending-hash.md docs/data-model.md
git commit -m "docs(stateless): supersede ADR 0007 (pending hash) for hash-first import"
```

---

## Task 5: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Native suite green.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed.

- [ ] **Step 2: TS typecheck + suite green.** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 3: Confirm the pending/migrate/fresh machinery is gone.** Run: `rg -n "pending_hash_for|migrate_hash_artifacts|patch_derivative_paths_after_hash_migration|rewrite_hash_in_path|fresh_media_item|read_mirror_handle" apps/desktop/native/src`
Expected: **no matches** (the guard-test string literals in `napi_backend.rs` are the only acceptable hits — they assert the absence; if any non-test source line matches, it was missed). Also run `rg -n "snapshot_for_read|set_project_mirror|ReadMirror" apps/desktop/native/src` and confirm only `napi_backend.rs` (the `read_mirror` field + `set_project_mirror` + the two `#[allow(dead_code)]` readers + the guard) match — these survive until Phase 5.

- [ ] **Step 4: Confirm no `pending-` cache keyspace appears on disk (the spec's regression invariant).** Manual smoke, real app, with the addon rebuilt (Task 1 Step 6): create or open a workspace, import a real video file, and after the proxy/thumbnail/waveform jobs complete, inspect `<workspace>/Cache/{proxies,thumbnails,waveforms,audio}`. Expected: every artifact filename starts with the real content hash; **zero** files/dirs named `pending-*`. The clip should appear in the timeline immediately on drop (before hashing completes). Re-import the SAME file → a cache hit (content-addressed) → no regeneration.

- [ ] **Step 5: Confirm no-workspace import still works.** Manual smoke: before saving to a workspace (boot fallback cache), import a video. Expected: the clip appears, derivatives generate against the OS-app-cache root keyed on the real hash, and the pool item's `file_hash_blake3` is the real hash (not `pending-*`) — verifiable via `project://current` or the media pool inspector.

---

## Self-review notes (for the executor)

- **Why Task 2 before Task 3 (and why it stays green between them):** After Task 2, the import bakes the real hash into the `MediaItem` handed to `enqueueDerivatives`, so the still-present Rust jobs (which take the mirror handle until Task 3) write to the real cache key. The copy's `migrate_hash_artifacts(pending-{id} → real)` then finds no `pending-{id}` files (none were written) and `patch_…` finds no `pending-` substring in the already-real derivative paths → both are harmless no-ops. Task 3 only deletes machinery that has become inert. Reversing the order would orphan derivatives at `pending-{id}` with no migration.
- **Instant appearance is preserved** by `add_media_item` (which `broadcastUnrecorded`s `project:changed` synchronously) running *before* the awaited `hashMediaSource` pass. `runHybrid` awaits the hash (deterministic for tests, errors propagate); the clip is already on the timeline by then. For a multi-GB file the import *call* resolves later, but the UI is not blocked.
- **Provisional representation = sentinel, not a flag.** The spec left this open; the sentinel (`file_hash_blake3 = "pending-{id}"`) is the lower-churn choice — no `MediaItem` data-model change, no Rust struct twin, no serialization/validation churn. It is never a cache key because no derivative enqueues until `set_media_hash` lands the real hash. An explicit `hash_pending` bool field would have been more invasive for no behavioral gain here.
- **`set_media_hash` is TS-only + UNRECORDED.** The Rust actor was deleted in the state-actor migration, so there is no Rust twin to keep in sync. It is durable across undo (a content fact, not an edit) — mirroring `set_media_workspace_paths` / `set_media_derivatives`. It is deliberately **not** added to `replay.ts` `SUPPORTED_OPS` (the differential corpus vocabulary) — the corpus never emits it, and the differential gate compares against frozen golden vectors, not a live Rust oracle.
- **`hashMediaSource` is required on `ComputeNapi`** (not optional) so the import arm needs no fallback; the cost is updating the six test stubs + the production facade (Task 2 Steps 6 & 9). All are mechanical one-line additions.
- **The residual hash-window race is strictly improved, not introduced.** A consumer that keys off the pool item's hash (e.g. playback-triggered `ensure_conform`) during the brief window between `add_media_item` and `set_media_hash` would see the provisional value — but today that window is the *entire copy duration* (the pool carries `pending-{id}` until the copy finishes), whereas hash-first shrinks it to the (much shorter) standalone hash pass. Fully eliminating it (blocking playback until hashed) is out of scope.
- **What stays for Phase 5:** `read_mirror` (the field), `set_project_mirror`, `snapshot_for_read`, `mirror_history_view`, the `ReadMirror` struct, and the per-commit `pushMirror` / `setProjectMirror` push. After Phase 4 the field is write-only-plus-dead-code-readers; Phase 5 deletes it wholesale and removes the per-commit push (the renderer-facing `project:changed` + `project_summary` pull are unchanged).
- **Within Task 3, build hygiene:** dropping the `mirror` param can leave an unused `use crate::napi_backend::ReadMirror;`-style import in `jobs/mod.rs` (it referenced `ReadMirror` only via the param types) — but `jobs/mod.rs` referenced `ReadMirror` inline (`crate::napi_backend::ReadMirror`), not via a `use`, so removing the params suffices. In `jobs/import.rs` the `use crate::napi_backend::ReadMirror;` IS a top-level import and must be removed (Step 4b). Let `cargo test` surface any stragglers as warnings and clear them before committing.
