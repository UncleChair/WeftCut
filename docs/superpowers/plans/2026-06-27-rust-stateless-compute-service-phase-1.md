# Rust stateless-compute-service — Phase 1: single-media read channels

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the four single-`MediaItem` read channels (`get_media_thumbnail`, `get_waveform_peaks`, `ensure_full_proxy`, `ensure_conform`) so the Electron main process passes the `MediaItem` it owns, instead of the Rust core reading it from the resident read-mirror.

**Architecture:** Spec `docs/superpowers/specs/2026-06-27-rust-stateless-compute-service-design.md`, Phase 1. These four channels are invoked from the renderer with `{ mediaId }`, forwarded to Rust by `index.ts`'s `backend:invoke` handler (they are in `MIRROR_BACKED_READS`). Today each Rust fn calls `snapshot_for_read()` to look up the item. After this phase, `index.ts` resolves the `MediaItem` from the TS actor snapshot and forwards `{ item }`; the Rust fns take the item directly and no longer touch the mirror. The renderer is unchanged. The mirror and `snapshot_for_read` still exist (other readers use them until later phases); this phase only removes these four readers.

**Tech Stack:** Rust (napi-rs addon, `apps/desktop/native`), TypeScript (Electron main, `apps/desktop/src/main`). Rust async via tokio; tests via `cargo test`. TS tests via vitest.

## Global Constraints

- Native Rust build/test MUST pass `--features export,mcp,cloud` — the default (no-feature) build does not compile. (Memory: feature set is `jobs/export/cloud/mcp`; `export` and `cloud` both imply `jobs`.)
- The TS `MediaItem` model is JSON-native: a `media_pool` entry from `actor.snapshot()` is already in Rust wire shape (`serialize.ts` applies no per-item transform). Forward it verbatim — do NOT invent a `serializeMediaItem` helper.
- Do not change the renderer (`src/renderer/ipc/index.ts` keeps sending `{ mediaId }`).
- Do not delete `read_mirror` / `set_project_mirror` / `snapshot_for_read` in this phase — other readers still use them. `ensure_full_proxy` / `ensure_conform` still pass `backend.read_mirror_handle()` to their `enqueue_*` calls (the background job's `fresh_media_item` re-read); that handle is removed in Phase 4.
- Commit after each task. Stage by explicit path (other sessions edit this checkout concurrently).
- End every task green on `cargo test --features export,mcp,cloud` and `npm --prefix apps/desktop test` + `npm --prefix apps/desktop run typecheck`.

---

## File Structure

- `apps/desktop/native/src/commands/mod.rs` — add `MediaItemArgs { item: MediaItem }` next to the existing `MediaIdArgs`.
- `apps/desktop/native/src/commands/media.rs` — change the four fn signatures to take `MediaItem`; drop their `snapshot_for_read` calls; update the in-file `mirror_tests`.
- `apps/desktop/native/src/napi_backend.rs` — the four `dispatch` arms parse `MediaItemArgs`; update the `get_waveform_peaks_unknown_media_errors` test and the source-guard test that requires `snapshot_for_read`.
- `apps/desktop/src/main/index.ts` — in the `backend:invoke` handler, resolve the `MediaItem` from `tsHost.actor.snapshot()` for these four channels and forward `{ item }`.

---

## Task 1: Rust — `get_media_thumbnail` + `get_waveform_peaks` take a `MediaItem`

These two are pure reads (no enqueue, no `backend` use beyond the snapshot). They become free functions of the item.

**Files:**
- Modify: `apps/desktop/native/src/commands/mod.rs` (add `MediaItemArgs`)
- Modify: `apps/desktop/native/src/commands/media.rs:92-113` (the two fns) and `:154-198` (their tests)
- Modify: `apps/desktop/native/src/napi_backend.rs:464-471` (dispatch arms)

**Interfaces:**
- Produces: `pub struct MediaItemArgs { pub item: crate::state::MediaItem }` (serde `Deserialize`).
- Produces: `pub async fn get_media_thumbnail(item: MediaItem) -> Result<String, String>`
- Produces: `pub async fn get_waveform_peaks(item: MediaItem) -> Result<WaveformPeaks, String>`

- [ ] **Step 1: Add the arg struct.** In `apps/desktop/native/src/commands/mod.rs`, next to `MediaIdArgs`, add:

```rust
/// Args for the single-media compute channels that now receive the resolved
/// `MediaItem` from the TS host (the sole state owner) instead of a bare id.
#[derive(serde::Deserialize)]
pub struct MediaItemArgs {
    pub item: crate::state::MediaItem,
}
```

- [ ] **Step 2: Rewrite the two read tests to pass the item (failing).** In `apps/desktop/native/src/commands/media.rs`, replace the `get_media_thumbnail_reads_mirror` test with one that dispatches with `{ item }` and no mirror push:

```rust
/// `get_media_thumbnail` resolves from the passed-in item (no mirror).
/// `thumbnails_dir` is None → "not_ready" proves it read the arg.
#[cfg(feature = "jobs")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_media_thumbnail_uses_passed_item() {
    let sink = Arc::new(crate::events::VecEventSink::new());
    let b = crate::napi_backend::Backend::new_for_test(sink as Arc<dyn crate::events::EventSink>);
    b.init().await.unwrap();
    let id = uuid::Uuid::now_v7();
    let item = mirror_only_item(id); // thumbnails_dir: None
    let args = serde_json::json!({ "item": item }).to_string();
    let err = b.dispatch("get_media_thumbnail", &args).await.unwrap_err();
    assert_eq!(err, "not_ready", "expected not_ready from passed item, got: {err}");
}
```

- [ ] **Step 3: Run it — verify it fails to compile / errors.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud get_media_thumbnail_uses_passed_item`
Expected: FAIL — the dispatch arm still parses `MediaIdArgs` / the fn still takes `media_id`.

- [ ] **Step 4: Convert the two fns.** In `apps/desktop/native/src/commands/media.rs`, replace `get_media_thumbnail` and `get_waveform_peaks` with:

```rust
pub async fn get_media_thumbnail(item: MediaItem) -> Result<String, String> {
    let dir = item.thumbnails_dir.clone().ok_or_else(|| "not_ready".to_string())?;
    let path = dir.join("004.jpg");
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read thumbnail: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

pub async fn get_waveform_peaks(item: MediaItem) -> Result<WaveformPeaks, String> {
    let path = item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let peaks = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_peaks_file(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read peaks: {e:#}"))?;
    Ok(WaveformPeaks { peaks, peaks_per_second: crate::jobs::waveform::PEAKS_PER_SECOND })
}
```

- [ ] **Step 5: Update the two dispatch arms.** In `apps/desktop/native/src/napi_backend.rs`, replace the `get_media_thumbnail` and `get_waveform_peaks` arms:

```rust
"get_media_thumbnail" => {
    let a: crate::commands::MediaItemArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
    ser(crate::commands::media::get_media_thumbnail(a.item).await)
}
"get_waveform_peaks" => {
    let a: crate::commands::MediaItemArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
    ser(crate::commands::media::get_waveform_peaks(a.item).await)
}
```

- [ ] **Step 6: Fix the `get_waveform_peaks_unknown_media_errors` test.** In `apps/desktop/native/src/napi_backend.rs:570`, the "unknown media" case no longer exists at the Rust layer (the item is passed in). Replace it with a malformed-args test:

```rust
#[cfg(feature = "jobs")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_waveform_peaks_rejects_malformed_args() {
    let sink = std::sync::Arc::new(crate::events::VecEventSink::new());
    let b = Backend::new_for_test(sink as std::sync::Arc<dyn crate::events::EventSink>);
    b.init().await.unwrap();
    // No `item` field → serde deserialize fails.
    let err = b.dispatch("get_waveform_peaks", "{}").await.unwrap_err();
    assert!(err.contains("item") || err.contains("missing"), "expected a parse error, got: {err}");
}
```

- [ ] **Step 7: Run the changed tests.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud get_media_thumbnail_uses_passed_item get_waveform_peaks_rejects_malformed_args`
Expected: PASS (both).

- [ ] **Step 8: Full native suite.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed. (If the source-guard test at `napi_backend.rs:828-835` fails because it still requires `get_media_thumbnail`/`get_waveform_peaks` to call `snapshot_for_read`, that is fixed in Task 3 — note the failure and proceed; do not commit until Task 3 if it fails here. If it passes, the guard does not cover these two — proceed.)

- [ ] **Step 9: Commit.**

```bash
git add apps/desktop/native/src/commands/mod.rs apps/desktop/native/src/commands/media.rs apps/desktop/native/src/napi_backend.rs
git commit -m "refactor(stateless): get_media_thumbnail/get_waveform_peaks take MediaItem"
```

---

## Task 2: Rust — `ensure_full_proxy` + `ensure_conform` take a `MediaItem`

These two enqueue jobs. They keep `backend` (for `events`, `cache`, and `read_mirror_handle()` — the latter stays until Phase 4) but stop calling `snapshot_for_read`.

**Files:**
- Modify: `apps/desktop/native/src/commands/media.rs:115-146` (the two fns) and the `ensure_full_proxy` seam test (~`:200+`)
- Modify: `apps/desktop/native/src/napi_backend.rs:474-481` (dispatch arms)

**Interfaces:**
- Consumes: `MediaItemArgs` (Task 1).
- Produces: `pub async fn ensure_full_proxy(backend: &Backend, item: MediaItem) -> Result<(), String>`
- Produces: `pub async fn ensure_conform(backend: &Backend, item: MediaItem) -> Result<(), String>`

- [ ] **Step 1: Update the `ensure_full_proxy` seam test to pass the item (failing).** In `apps/desktop/native/src/commands/media.rs`, find the test asserting `ensure_full_proxy` emits `media:derivatives` (it currently pushes a mirror then dispatches `{ mediaId }`). Change it to build the item, dispatch `{ item }`, and drop the `set_project_mirror` call:

```rust
let id = uuid::Uuid::now_v7();
let item = mirror_only_item(id);
let args = serde_json::json!({ "item": item }).to_string();
b.dispatch("ensure_full_proxy", &args).await.unwrap();
// ... existing assertions that a media:derivatives event was emitted ...
```

- [ ] **Step 2: Run it — verify it fails.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud ensure_full_proxy`
Expected: FAIL — dispatch arm/fn still take `media_id`.

- [ ] **Step 3: Convert the two fns.** In `apps/desktop/native/src/commands/media.rs`, replace `ensure_full_proxy` and `ensure_conform`:

```rust
pub async fn ensure_full_proxy(backend: &Backend, item: MediaItem) -> Result<(), String> {
    let id = item.id;
    if item.proxy_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return Ok(());
    }
    crate::jobs::commit_media_derivatives(
        &backend.events, id,
        state::MediaDerivativesPatch { export_uses_original: Some(false), ..Default::default() },
    ).await.map_err(|e| format!("route-correct {id}: {e}"))?;
    crate::jobs::enqueue_full_proxy(backend.events.clone(), backend.cache.clone(), item, backend.read_mirror_handle());
    Ok(())
}

pub async fn ensure_conform(backend: &Backend, item: MediaItem) -> Result<(), String> {
    if item.metadata.audio.is_none() {
        return Ok(());
    }
    if crate::cache::cached_ok(&backend.cache.audio_conform(&item.file_hash_blake3)) {
        return Ok(());
    }
    crate::jobs::enqueue_conform(backend.events.clone(), backend.cache.clone(), item, backend.read_mirror_handle());
    Ok(())
}
```

- [ ] **Step 4: Update the two dispatch arms.** In `apps/desktop/native/src/napi_backend.rs`:

```rust
"ensure_full_proxy" => {
    let a: crate::commands::MediaItemArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
    ser(crate::commands::media::ensure_full_proxy(self, a.item).await)
}
"ensure_conform" => {
    let a: crate::commands::MediaItemArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
    ser(crate::commands::media::ensure_conform(self, a.item).await)
}
```

- [ ] **Step 5: Run the changed test.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud ensure_full_proxy`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/native/src/commands/media.rs apps/desktop/native/src/napi_backend.rs
git commit -m "refactor(stateless): ensure_full_proxy/ensure_conform take MediaItem"
```

---

## Task 3: Rust — relax the `snapshot_for_read` source-guard for the four channels

`napi_backend.rs` has a source-grep guard test (~`:804-849`) asserting that "mirror-backed reads" call `snapshot_for_read` and never `.project()?.snapshot()`. The four converted channels are no longer mirror-backed, so the guard must stop requiring `snapshot_for_read` for them (it still applies to the export channels until Phase 2).

**Files:**
- Modify: `apps/desktop/native/src/napi_backend.rs:804-849` (the guard test)

**Interfaces:** none (test-only).

- [ ] **Step 1: Read the guard test** at `apps/desktop/native/src/napi_backend.rs:804-849` to see which fn names it scans (it greps `commands/media.rs` source for `fn <name>` then asserts the body contains `snapshot_for_read`).

- [ ] **Step 2: Narrow the guard's name set.** Edit the guard so its "must call `snapshot_for_read`" assertion no longer includes `get_media_thumbnail`, `get_waveform_peaks`, `ensure_full_proxy`, `ensure_conform`. Keep the `.project()?.snapshot()` prohibition (that stale-actor read must never appear). Add a positive assertion that these four now take a `MediaItem`:

```rust
// Phase 1 (stateless-compute-service): these four no longer read the mirror —
// the TS host passes the resolved MediaItem. Assert they DON'T call snapshot_for_read.
for name in ["get_media_thumbnail", "get_waveform_peaks", "ensure_full_proxy", "ensure_conform"] {
    let start = media.find(&format!("fn {name}")).unwrap_or_else(|| panic!("{name} must exist"));
    let body = &media[start..(start + 600).min(media.len())];
    assert!(!body.contains("snapshot_for_read"),
        "{name}: must NOT read the mirror — it takes a MediaItem arg (Phase 1)");
}
```

- [ ] **Step 3: Run the guard + full native suite.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed.

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/native/src/napi_backend.rs
git commit -m "test(stateless): guard the four channels do NOT read the mirror"
```

---

## Task 4: Main — resolve the `MediaItem` and forward `{ item }`

The renderer keeps calling `invoke("<channel>", { mediaId })`. `index.ts`'s `backend:invoke` handler must, for these four channels, resolve the item from the TS actor snapshot and forward `{ item }` to the napi backend. A missing item returns the same "not found" error the renderer expects.

**Files:**
- Modify: `apps/desktop/src/main/index.ts:368-405` (the `backend:invoke` handler)
- Test: `apps/desktop/src/main/state/__tests__/` (new host-level test, see Step 1)

**Interfaces:**
- Consumes: `tsHost.actor.snapshot()` → `{ media_pool: Record<string, MediaItem> }` (model.ts).
- Produces: forwarded napi args `{ item: MediaItem }` for the four channels.

- [ ] **Step 1: Write the failing test.** Create `apps/desktop/src/main/state/__tests__/single-media-forward.test.ts`. It exercises the resolution logic directly (extract it into a small pure helper in Step 3 so it is unit-testable without Electron):

```ts
import { describe, it, expect } from 'vitest'
import { resolveSingleMediaArgs } from '../single-media-forward'

const item = { id: 'm1', label: null, kind: 'Video', file_hash_blake3: 'h' } as never

describe('resolveSingleMediaArgs', () => {
  it('replaces { mediaId } with the resolved { item }', () => {
    const pool = { m1: item }
    expect(resolveSingleMediaArgs({ mediaId: 'm1' }, pool)).toEqual({ item })
  })
  it('throws a not-found error when the id is absent', () => {
    expect(() => resolveSingleMediaArgs({ mediaId: 'gone' }, {})).toThrow(/media gone not found/)
  })
})
```

- [ ] **Step 2: Run it — verify it fails.** Run: `npm --prefix apps/desktop test -- single-media-forward`
Expected: FAIL — `../single-media-forward` does not exist.

- [ ] **Step 3: Write the helper.** Create `apps/desktop/src/main/state/single-media-forward.ts`:

```ts
import type { MediaItem } from './model'

/** Channels that used to read the Rust mirror for one MediaItem and now receive
 *  it from the TS actor (the sole state owner). */
export const SINGLE_MEDIA_CHANNELS: ReadonlySet<string> = new Set([
  'get_media_thumbnail', 'get_waveform_peaks', 'ensure_full_proxy', 'ensure_conform',
])

/** Map renderer `{ mediaId }` args to the `{ item }` the Rust fn now expects.
 *  Throws the same "not found" error surface the old Rust lookup produced. */
export function resolveSingleMediaArgs(
  args: { mediaId?: string },
  pool: Record<string, MediaItem>,
): { item: MediaItem } {
  const id = args.mediaId ?? ''
  const item = pool[id]
  if (!item) throw new Error(`media ${id} not found`)
  return { item }
}
```

- [ ] **Step 4: Run the test.** Run: `npm --prefix apps/desktop test -- single-media-forward`
Expected: PASS.

- [ ] **Step 5: Wire it into the handler.** In `apps/desktop/src/main/index.ts`, inside `ipcMain.handle('backend:invoke', ...)`, AFTER the existing main-only intercepts and BEFORE the `tsHost` route split (i.e. before line 399), add:

```ts
    // Single-media compute: the TS actor owns state, so resolve the MediaItem
    // here and forward it — the Rust fns no longer read the mirror (Phase 1).
    if (tsHost && SINGLE_MEDIA_CHANNELS.has(channel)) {
      const pool = tsHost.actor.snapshot().media_pool as Record<string, import('./state/model.js').MediaItem>
      const resolved = resolveSingleMediaArgs((args ?? {}) as { mediaId?: string }, pool)
      const json = await backend!.invoke(channel, JSON.stringify(resolved))
      return JSON.parse(json)
    }
```

Add the import near the top of `index.ts`:

```ts
import { SINGLE_MEDIA_CHANNELS, resolveSingleMediaArgs } from './state/single-media-forward.js'
```

- [ ] **Step 6: Typecheck + full TS suite.** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/state/single-media-forward.ts apps/desktop/src/main/state/__tests__/single-media-forward.test.ts
git commit -m "refactor(stateless): main resolves MediaItem for single-media channels"
```

---

## Task 5: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Native suite green.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed.

- [ ] **Step 2: TS typecheck + suite green.** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 3: Manual smoke (optional, real app).** Build the addon (`npm --prefix apps/desktop run napi:build` — close the app first; the running `.node` is locked) and launch; import a video, confirm the timeline thumbnail and the waveform render, and that proxy/conform still generate. This exercises the four channels end-to-end through the new main-resolution path.

- [ ] **Step 4: Confirm the mirror is untouched.** Grep proves the four fns no longer read the mirror, and the mirror still exists for other readers:
Run: `rg "snapshot_for_read" apps/desktop/native/src/commands/media.rs`
Expected: no matches in `media.rs` (export.rs, mcp/tools.rs, resources.rs still match — those are later phases).

---

## Self-review notes (for the executor)

- Phase 1 leaves `read_mirror` / `set_project_mirror` / `snapshot_for_read` in place — by design. Do not delete them here.
- `ensure_full_proxy` / `ensure_conform` still pass `backend.read_mirror_handle()` to `enqueue_*`; the background job's `fresh_media_item` re-read is removed in Phase 4 (it needs the hash-first guarantee).
- If `actor.snapshot().media_pool` is a `Map` rather than a plain object in the current model, adjust `resolveSingleMediaArgs` to take a `Map` and the handler to pass it; the test and helper must agree. Verify against `model.ts` before Step 3.
- Next phases (own plan files): Phase 2 (export audio + detect_silences/transcribe_clip slices), Phase 3 (MCP resources → TS), Phase 4 (import hash-first rework + delete `fresh_media_item`/`pending`/migrate), Phase 5 (delete the mirror + the per-commit push).
