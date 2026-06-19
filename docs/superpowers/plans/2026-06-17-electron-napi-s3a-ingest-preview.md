# S3a — Ingest + Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under Electron, import a media file via the file picker → background jobs generate proxies/thumbnails/waveform/conform (live UI events) → scrub-preview decodes frames from media served over a custom `weftcut-media://` protocol.

**Architecture:** Turn on the Rust `jobs` feature in the napi addon and decouple `jobs` + `import` from `tauri::AppHandle` onto the S2 `EventSink`/`LogBusSlot`. Re-home the media commands into `commands/media.rs` (`&Backend` fns) and add dispatcher arms. Add an Electron-main `weftcut-media://` protocol with HTTP Range, plus `dialog:`/`path:` handlers and a window-resize forwarder. No `src/**` app-code edits — only the sanctioned `electron-compat/` shim layer (`convertFileSrc`) and `electron/` main/preload.

**Tech Stack:** Rust (napi-rs v3, tokio, ffmpeg-sidecar, serde_json), Electron 40 (`protocol.handle`, `dialog`, `ipcMain`), Playwright-for-Electron, the existing React/Vite/PixiJS renderer (unchanged).

## Global Constraints

- **Branch:** `migration/electron-napi`. Never commit to `main`. **Stage by explicit path** (parallel sessions edit this checkout); re-check `git status` before each commit.
- **No `src/**` app-code edits.** The only renderer-side change is the `convertFileSrc` body in `apps/desktop/src/electron-compat/tauri-core.ts` (sanctioned compat layer). Everything else is additive under `apps/desktop/electron/` or `apps/desktop/src-tauri/`.
- **S3a enables the `jobs` cargo feature only** (it transitively pulls `audio`, `ffmpeg`, `io::probe`). `export` is S3b. `cloud`/`mcp`/`motifs` stay OFF.
- **Event names are unchanged** (`media:job_started`/`media:job_complete`/`media:job_error`, `import:queue`/`import:started`/`import:complete`/`import:error`) so the renderer's listeners + the `evt:<name>` bridge work untouched.
- **EventSink contract:** `trait EventSink { fn emit(&self, event: &str, payload: serde_json::Value); }` (`src-tauri/src/events.rs`). `Backend` holds `events: Arc<dyn EventSink>` and `log_slot: LogBusSlot`, both already constructed in `build_backend`.
- **Backend accessors:** command modules reach the actor via `backend.project()? -> &ProjectHandle`; `backend.cache` is a `CacheLayout` (Clone); `backend.workspace` is a `WorkspaceSlot`; `backend.events` is `Arc<dyn EventSink>` (Clone).
- **Dispatcher:** `Backend::dispatch(cmd, args)` at `src-tauri/src/napi_backend.rs:202`; the `other => Err("unavailable…")` arm is at line 382; `ser<T: Serialize>(Result<T,String>) -> Result<String,String>` helper at line 388.
- **Media protocol scheme:** `weftcut-media://localhost/<encodeURIComponent(absPath)>`; serve existing regular files by absolute path (403 non-absolute/undecodable, 404 missing/non-regular, 416 bad range). No artificial body cap.
- **Build commands:** addon `cd apps/desktop && npm run napi:build` (S3a appends `--features jobs`); Rust tests `cd apps/desktop/src-tauri && cargo test --lib --features jobs`; e2e `cd apps/desktop && npm run electron:build && npm run e2e:electron`.

---

## File Structure

- `apps/desktop/src-tauri/Cargo.toml` — (no change; `jobs` feature already declared)
- `apps/desktop/package.json` — `napi:build` script gains `--features jobs`
- `apps/desktop/src-tauri/src/jobs/mod.rs` — MODIFY: `AppHandle`→`Arc<dyn EventSink>` decouple
- `apps/desktop/src-tauri/src/jobs/import.rs` — MODIFY: `ImportQueue` holds `events`+`log_slot`; `tauri::async_runtime::spawn`→`tokio::spawn`; `logs::emit_via_app`→`log_slot.emit`
- `apps/desktop/src-tauri/src/logs/mod.rs` — MODIFY: drop `jobs` from `emit_via_app`'s cfg gate
- `apps/desktop/src-tauri/src/napi_backend.rs` — MODIFY: `import_queue`/`audio_meter` fields; ffmpeg bootstrap in `init`; dispatch arms
- `apps/desktop/src-tauri/src/commands/media.rs` — CREATE: the 8 S3a media commands as `&Backend` fns + `WaveformPeaks`/`AudioMeterReport`/`AudioMeterState`
- `apps/desktop/src-tauri/src/commands/mod.rs` — MODIFY: `pub mod media;` + `MediaIdArgs`/`MediaWindowArgs` structs
- `apps/desktop/src-tauri/src/commands/persistence.rs:103` — MODIFY: re-wire `enqueue_for_media` in `project_open`
- `apps/desktop/electron/main/index.ts` — MODIFY: register scheme + `protocol.handle` + dialog/path handlers + resize forwarder
- `apps/desktop/electron/preload/index.ts` — MODIFY: route `dialog:` channels
- `apps/desktop/src/electron-compat/tauri-core.ts` — MODIFY: `convertFileSrc` returns a `weftcut-media://` URL
- `apps/desktop/e2e/electron/s3a-import.spec.ts` — CREATE: the S3a import gate
- `apps/desktop/electron/S3a-NOTES.md` — CREATE: acceptance notes

---

## Task 1: Enable `jobs`; decouple jobs + import from `AppHandle`; ffmpeg bootstrap

Enabling the `jobs` feature re-introduces `jobs`, `audio`, `ffmpeg`, `io::probe` into the build — but those modules still reference `tauri::AppHandle`/`app.emit`, which no longer exist (Tauri was stripped in S2). So the feature flip and the EventSink decouple are one inseparable build-green unit. No command wiring yet.

**Files:**
- Modify: `apps/desktop/package.json` (script)
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs`
- Modify: `apps/desktop/src-tauri/src/jobs/import.rs`
- Modify: `apps/desktop/src-tauri/src/logs/mod.rs:31`
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs` (`init` only)

**Interfaces:**
- Produces (jobs/mod.rs): `pub fn enqueue_for_media(events: Arc<dyn EventSink>, cache: CacheLayout, project: ProjectHandle, media: MediaItem)`; `pub fn enqueue_full_proxy(events: Arc<dyn EventSink>, …)`; `pub fn enqueue_conform(events: Arc<dyn EventSink>, …)` — same trailing args as today, first param `AppHandle`→`Arc<dyn EventSink>`.
- Produces (import.rs): `ImportQueue::new(events: Arc<dyn EventSink>, log_slot: LogBusSlot) -> ImportQueue`; `enqueue`/`cancel`/`list` signatures unchanged.

- [ ] **Step 1: Confirm the build fails before decoupling**

Run: `cd apps/desktop && npm run napi:build -- --features jobs`
Expected: FAIL — compile errors in `jobs`/`import` like `cannot find type AppHandle`, `use of undeclared crate or module tauri`, `no method emit`. This is the starting state.

- [ ] **Step 2: Add `--features jobs` to the build script**

In `apps/desktop/package.json`, change the `napi:build` script:
```json
"napi:build": "napi build --platform --release --manifest-path src-tauri/Cargo.toml --output-dir src-tauri --features jobs",
```

- [ ] **Step 3: Decouple `jobs/mod.rs` — imports + emit helper**

In `apps/desktop/src-tauri/src/jobs/mod.rs`, replace the tauri import (line 41) and rewrite the `emit` helper (lines 696–698):

Replace:
```rust
use tauri::{AppHandle, Emitter};
```
with:
```rust
use std::sync::Arc;

use crate::events::EventSink;
```

Replace the `emit` helper:
```rust
fn emit<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: &T) {
    let _ = app.emit(event, payload);
}
```
with:
```rust
fn emit<T: Serialize>(events: &Arc<dyn EventSink>, event: &str, payload: &T) {
    events.emit(event, serde_json::to_value(payload).unwrap_or(serde_json::Value::Null));
}
```

- [ ] **Step 4: Decouple `jobs/mod.rs` — every spawn/enqueue signature**

Mechanical rule applied to ALL of these functions: change the first parameter `app: AppHandle` to `events: Arc<dyn EventSink>`; inside each body change `emit(&app, …)` → `emit(&events, …)`, `app.clone()` → `events.clone()`, and every recursive call `spawn_x(app, …)` / `spawn_x(app.clone(), …)` → `spawn_x(events, …)` / `spawn_x(events.clone(), …)`. The function list (every `app: AppHandle` site in this file):

`enqueue_full_proxy`, `enqueue_for_media`, `spawn_decorations`, `enqueue_conform`, `spawn_conform`, `spawn_proxy_decision`, `spawn_thumbnails`, `spawn_quick_proxy`, `spawn_proxy`, `spawn_waveform`.

No body logic changes beyond the `app`→`events` rename — the `set_media_derivatives` / `ffmpeg_sem` / `fresh_media_item` calls are unchanged.

- [ ] **Step 5: Decouple `jobs/import.rs`**

In `apps/desktop/src-tauri/src/jobs/import.rs`:

Replace the tauri import (line 36):
```rust
use tauri::{AppHandle, Emitter};
```
with:
```rust
use std::sync::Arc as StdArc;

use crate::events::EventSink;
use crate::logs::LogBusSlot;
```
(`Arc` is already imported on line 31 as `std::sync::{Arc, Mutex}`; use that `Arc` — drop the `StdArc` alias if the existing `Arc` import is in scope. Keep one `Arc`.)

Change the `ImportQueue` struct field (lines 77–80):
```rust
#[derive(Clone)]
pub struct ImportQueue {
    inner: Arc<Mutex<ImportQueueInner>>,
    events: Arc<dyn EventSink>,
    log_slot: LogBusSlot,
}
```

Change the constructor (lines 104–114):
```rust
pub fn new(events: Arc<dyn EventSink>, log_slot: LogBusSlot) -> Self {
    Self {
        inner: Arc::new(Mutex::new(ImportQueueInner {
            pending: VecDeque::new(),
            running: None,
            history: Vec::new(),
            worker_alive: false,
        })),
        events,
        log_slot,
    }
}
```

Change `emit_queue` (lines 197–202):
```rust
fn emit_queue(&self) {
    let snapshot = self.list();
    self.events
        .emit(events::QUEUE, serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null));
}
```
(`events::QUEUE` is the path to the `events` *module*'s const; `self.events` is the field — Rust disambiguates, no rename needed.)

Change the worker spawn (line 150): `tauri::async_runtime::spawn(...)` → `tokio::spawn(...)`.

Replace EVERY `logs::emit_via_app(app, <input>)` call (4 sites: lines ~243, 301, 339, 373, inside `worker_loop`/its copy helper, which own/borrow `self`) with `self.log_slot.emit(<input>)`. If any call site is in a helper fn without `self`, pass `&self.log_slot` (a `&LogBusSlot`) into that helper and call `.emit(<input>)`.

- [ ] **Step 6: Ungate `emit_via_app` from `jobs`**

In `apps/desktop/src-tauri/src/logs/mod.rs`, change the cfg attribute on `emit_via_app` (line 31) from:
```rust
#[cfg(any(feature = "jobs", feature = "mcp", feature = "motifs"))]
```
to:
```rust
#[cfg(any(feature = "mcp", feature = "motifs"))]
```
(`jobs` no longer calls it — `import.rs` now uses `log_slot.emit` directly. `mcp`/`motifs` keep it for their stages.)

- [ ] **Step 7: ffmpeg bootstrap in `Backend::init`**

In `apps/desktop/src-tauri/src/napi_backend.rs`, inside `pub async fn init(&self)`, after the actor + bridge are spawned and before `Ok(())`, add:
```rust
        // S3: warm up ffmpeg-sidecar (resolve / auto-download the binary) off
        // the init path so the first media job doesn't pay the download.
        #[cfg(any(feature = "jobs", feature = "export"))]
        tokio::spawn(async {
            match crate::ffmpeg::bootstrap().await {
                Ok(crate::ffmpeg::BootstrapStatus::Ready(v)) => tracing::info!("ffmpeg ready: {v}"),
                Ok(crate::ffmpeg::BootstrapStatus::Unavailable(m)) => {
                    tracing::warn!("ffmpeg unavailable: {m}")
                }
                Err(e) => tracing::warn!("ffmpeg bootstrap error: {e:#}"),
            }
        });
```

- [ ] **Step 8: Build the addon with `jobs`**

Run: `cd apps/desktop && npm run napi:build`
Expected: PASS — `@weftcut/core` builds; no `AppHandle`/`tauri`/`emit` errors.

- [ ] **Step 9: Run the Rust unit tests with `jobs`**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs`
Expected: PASS — the prior S2 suite (334) PLUS the newly compiled `jobs`/`audio` tests (e.g. `jobs::tests::conform_in_flight_guard_dedups_until_ended`), 0 failed.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src-tauri/src/jobs/mod.rs apps/desktop/src-tauri/src/jobs/import.rs apps/desktop/src-tauri/src/logs/mod.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s3a): enable jobs feature; decouple jobs+import from AppHandle to EventSink; ffmpeg bootstrap"
```

---

## Task 2: Import lifecycle commands + `ImportQueue` field + `project_open` re-wire

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/media.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs` (`pub mod media;` + `MediaIdArgs`)
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs` (`import_queue` field, `build_backend`, dispatch arms)
- Modify: `apps/desktop/src-tauri/src/commands/persistence.rs:103`

**Interfaces:**
- Consumes: `Backend::project()`, `backend.cache: CacheLayout`, `backend.workspace: WorkspaceSlot`, `backend.events: Arc<dyn EventSink>`, `jobs::enqueue_for_media` (Task 1).
- Produces: `commands::media::import_media(&Backend, String) -> Result<String,String>`, `import_cancel(&Backend, String) -> Result<bool,String>`, `import_queue_list(&Backend) -> Result<Vec<jobs::import::ImportEntry>,String>`; `Backend.import_queue: ImportQueue`; dispatch arms `import_media`/`import_cancel`/`import_queue_list`.

- [ ] **Step 1: Write the failing test (Rust dispatch round-trip)**

Add to `apps/desktop/src-tauri/src/napi_backend.rs` test module (the `#[cfg(test)] mod tests` block that already holds the S2 dispatch tests):
```rust
    /// A 1×1 PNG (67 bytes) — imports as MediaKind::Image, so no ffmpeg job runs.
    #[cfg(feature = "jobs")]
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
        0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
        0x42, 0x60, 0x82,
    ];

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn import_media_adds_to_pool_and_returns_id() {
        let sink = crate::events::VecEventSink::new();
        let b = Backend::new_for_test(std::sync::Arc::new(sink.clone()));
        b.init().await.unwrap();

        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("pixel.png");
        std::fs::write(&png, TINY_PNG).unwrap();

        let args = serde_json::json!({ "path": png.to_string_lossy() }).to_string();
        let id_json = b.dispatch("import_media", &args).await.unwrap();
        let media_id: String = serde_json::from_str(&id_json).unwrap();
        assert!(!media_id.is_empty(), "import_media returns a media id");

        let summary = b.dispatch("project_summary", "{}").await.unwrap();
        assert!(summary.contains(&media_id), "the new media id appears in project_summary");
    }
```
(Match `new_for_test`'s actual constructor signature used by the existing S2 tests in this file — copy the exact call the neighbouring tests use. If they call `Backend::new_for_test()` with no args, drop the `sink` arg here and assert via `project_summary` only.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs import_media_adds_to_pool_and_returns_id`
Expected: FAIL — `import_media` hits the `unavailable` dispatch arm (`assert ... returns a media id` fails on the error string), or won't compile because `commands::media` doesn't exist yet.

- [ ] **Step 3: Add the `import_queue` field to `Backend` + construct it**

In `apps/desktop/src-tauri/src/napi_backend.rs`, add to the `Backend` struct (after `cache`):
```rust
    #[cfg(feature = "jobs")]
    pub(crate) import_queue: crate::jobs::import::ImportQueue,
```
In `build_backend`, after `let log_slot = LogBusSlot::new();` and the tracing init, construct it (it needs `events` + `log_slot`, both in scope):
```rust
    #[cfg(feature = "jobs")]
    let import_queue = crate::jobs::import::ImportQueue::new(events.clone(), log_slot.clone());
```
and add `import_queue,` to the `Backend { … }` initializer (under the same `#[cfg(feature = "jobs")]`? — struct field init can't be cfg'd inline cleanly; instead make the whole field unconditional is simplest: gate is fine since S3a always builds with `jobs`. Use a `#[cfg(feature = "jobs")] import_queue,` line in the initializer — Rust allows `cfg` on struct-init fields).

- [ ] **Step 4: Create `commands/media.rs` with the import commands**

Create `apps/desktop/src-tauri/src/commands/media.rs`:
```rust
//! S3 media commands — import lifecycle + derivative queries. Re-homed from the
//! Tauri `commands.rs` onto the napi `Backend`. Gated behind `jobs`.

use std::path::PathBuf;

use chrono::Utc;

use crate::io;
use crate::jobs::import::ImportEntry;
use crate::napi_backend::Backend;
use crate::state::{self, Actor, MediaItem, MediaKind};

/// Probe + hash a source file, insert a `MediaItem`, fan out derivative jobs,
/// and queue the background workspace copy. Returns the media id.
pub async fn import_media(backend: &Backend, path: String) -> Result<String, String> {
    let handle = backend.project()?;
    let cache = backend.cache.clone();
    let source_buf = PathBuf::from(&path);
    let media_id = uuid::Uuid::new_v4();
    let workspace_root = backend.workspace.current();
    let has_workspace = workspace_root.is_some();

    let item = tokio::task::spawn_blocking({
        let source_buf = source_buf.clone();
        move || -> Result<MediaItem, String> {
            let (file_size, file_mtime, file_hash_blake3) = if has_workspace {
                let (size, mtime) = io::probe::stat_file(&source_buf).map_err(|e| format!("{e:#}"))?;
                (size, mtime, format!("pending-{media_id}"))
            } else {
                let facts = io::probe::hash_and_stat(&source_buf).map_err(|e| format!("{e:#}"))?;
                (facts.size, facts.mtime_secs, facts.blake3_hex)
            };
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
                file_hash_blake3,
                file_size,
                file_mtime,
                imported_at: Utc::now(),
            })
        }
    })
    .await
    .map_err(|e| format!("import join: {e}"))??;

    let media_id = item.id;
    let item_for_jobs = item.clone();
    let id = handle
        .add_media_item(Actor::User, item)
        .await
        .map_err(|e| e.to_string())?;

    crate::jobs::enqueue_for_media(backend.events.clone(), cache.clone(), handle.clone(), item_for_jobs);

    if let Some(ws) = workspace_root {
        backend
            .import_queue
            .enqueue(handle.clone(), cache.clone(), media_id, source_buf, ws);
    } else {
        tracing::warn!(
            "import_media: no workspace set; MediaItem stays referencing the original source."
        );
    }

    Ok(id.to_string())
}

pub async fn import_cancel(backend: &Backend, media_id: String) -> Result<bool, String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;
    Ok(backend.import_queue.cancel(id))
}

pub async fn import_queue_list(backend: &Backend) -> Result<Vec<ImportEntry>, String> {
    Ok(backend.import_queue.list())
}
```
(If `MediaItem` has additional fields beyond those above, copy the full literal verbatim from `4a0dda90:apps/desktop/src-tauri/src/commands.rs:1745-1781` — the build will name any missing field. `add_media_item`'s error type maps via `.to_string()`.)

- [ ] **Step 5: Register the module + arg struct**

In `apps/desktop/src-tauri/src/commands/mod.rs`, add near the other `pub mod` lines:
```rust
#[cfg(feature = "jobs")]
pub mod media;
```
and add a shared single-id arg struct (near `PathArgs` at line 848):
```rust
#[cfg(feature = "jobs")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaIdArgs {
    pub media_id: String,
}
```

- [ ] **Step 6: Add the dispatch arms**

In `apps/desktop/src-tauri/src/napi_backend.rs`, just above the `other =>` arm (line 382), add:
```rust
            #[cfg(feature = "jobs")]
            "import_media" => {
                let a: crate::commands::PathArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::import_media(self, a.path).await)
            }
            #[cfg(feature = "jobs")]
            "import_cancel" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::import_cancel(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "import_queue_list" => ser(crate::commands::media::import_queue_list(self).await),
```

- [ ] **Step 7: Re-wire `enqueue_for_media` in `project_open`**

In `apps/desktop/src-tauri/src/commands/persistence.rs`, replace the `// NOTE (S2): …` block (lines 103–109) with:
```rust
    // S3a: re-fan-out background derivative jobs for every media item, to
    // regenerate proxies / thumbnails / waveforms missing or stale after
    // `load_from_dir`. Mirrors the legacy Tauri `project_open` tail.
    #[cfg(feature = "jobs")]
    {
        let snap = handle.snapshot().await;
        for item in snap.media_pool.values() {
            crate::jobs::enqueue_for_media(
                backend.events.clone(),
                backend.cache.clone(),
                handle.clone(),
                item.clone(),
            );
        }
    }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs import_media_adds_to_pool_and_returns_id`
Expected: PASS.

- [ ] **Step 9: Full suite still green**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs`
Expected: PASS, 0 failed.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/media.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/napi_backend.rs apps/desktop/src-tauri/src/commands/persistence.rs
git commit -m "migrate(s3a): import_media/cancel/queue_list commands + ImportQueue field + project_open job re-wire"
```

---

## Task 3: Derivative + meter commands + `AudioMeterState` field

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/media.rs` (add 5 fns + 3 types)
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs` (no new arg structs — reuse `MediaIdArgs`)
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs` (`audio_meter` field + dispatch arms)

**Interfaces:**
- Consumes: `Backend::project()`, `backend.cache`, `jobs::{enqueue_full_proxy, enqueue_conform, waveform}`, `cache::cached_ok`, `state::MediaDerivativesPatch`.
- Produces: `commands::media::{get_media_thumbnail, get_waveform_peaks, ensure_full_proxy, ensure_conform, report_audio_meter}`; types `WaveformPeaks`, `AudioMeterReport`, `AudioMeterState`; `Backend.audio_meter: AudioMeterState`; dispatch arms for the five commands.

- [ ] **Step 1: Write the failing test**

Add to the `napi_backend.rs` test module:
```rust
    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn get_waveform_peaks_unknown_media_errors() {
        let b = Backend::new_for_test_default(); // use the no-arg test ctor the other tests use
        b.init().await.unwrap();
        let args = serde_json::json!({ "mediaId": uuid::Uuid::new_v4().to_string() }).to_string();
        let err = b.dispatch("get_waveform_peaks", &args).await.unwrap_err();
        assert!(err.contains("not found"), "unknown media → not found, got: {err}");
    }

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn report_audio_meter_stores_snapshot() {
        let b = Backend::new_for_test_default();
        b.init().await.unwrap();
        let args = r#"{"report":{"rmsDb":-12.0,"peakDb":-3.0}}"#;
        let out = b.dispatch("report_audio_meter", args).await.unwrap();
        assert_eq!(out, "null", "report_audio_meter returns unit/null");
    }
```
(Use whatever no-arg test constructor the existing S2 tests use; the names above are placeholders for that exact call.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs get_waveform_peaks_unknown_media_errors report_audio_meter_stores_snapshot`
Expected: FAIL — both hit `unavailable` (or won't compile until the fns/arms exist).

- [ ] **Step 3: Add the derivative + meter commands to `commands/media.rs`**

Append to `apps/desktop/src-tauri/src/commands/media.rs`:
```rust
use base64::Engine;

/// Peaks payload for the timeline waveform. `peaks_per_second` maps a layer's
/// src window onto a slice of `peaks`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeaks {
    pub peaks: Vec<f32>,
    pub peaks_per_second: u32,
}

/// Master-bus meter reading pushed by the webview (~2 Hz while playing).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeterReport {
    pub rms_db: f64,
    pub peak_db: f64,
}

/// Latest meter report + arrival instant. Staleness (>2 s) reads as "not playing".
#[derive(Clone, Default)]
pub struct AudioMeterState(
    pub std::sync::Arc<std::sync::Mutex<Option<(std::time::Instant, AudioMeterReport)>>>,
);

pub async fn get_media_thumbnail(backend: &Backend, media_id: String) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let media = snap.media_pool.get(&id).ok_or_else(|| format!("media {media_id} not found"))?;
    let dir = media.thumbnails_dir.clone().ok_or_else(|| "not_ready".to_string())?;
    let path = dir.join("004.jpg");
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read thumbnail: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

pub async fn get_waveform_peaks(backend: &Backend, media_id: String) -> Result<WaveformPeaks, String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let media = snap.media_pool.get(&id).ok_or_else(|| format!("media {media_id} not found"))?;
    let path = media.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let peaks = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_peaks_file(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read peaks: {e:#}"))?;
    Ok(WaveformPeaks { peaks, peaks_per_second: crate::jobs::waveform::PEAKS_PER_SECOND })
}

pub async fn ensure_full_proxy(backend: &Backend, media_id: String) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    if item.proxy_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return Ok(());
    }
    handle
        .set_media_derivatives(
            Actor::Agent { client: "jobs".to_string() },
            id,
            state::MediaDerivativesPatch { export_uses_original: Some(false), ..Default::default() },
        )
        .await
        .map_err(|e| format!("route-correct {media_id}: {e}"))?;
    crate::jobs::enqueue_full_proxy(backend.events.clone(), backend.cache.clone(), handle.clone(), item);
    Ok(())
}

pub async fn ensure_conform(backend: &Backend, media_id: String) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    if item.metadata.audio.is_none() {
        return Ok(());
    }
    if crate::cache::cached_ok(&backend.cache.audio_conform(&item.file_hash_blake3)) {
        return Ok(());
    }
    crate::jobs::enqueue_conform(backend.events.clone(), backend.cache.clone(), handle.clone(), item);
    Ok(())
}

pub async fn report_audio_meter(backend: &Backend, report: AudioMeterReport) -> Result<(), String> {
    *backend.audio_meter.0.lock().map_err(|_| "meter lock poisoned".to_string())? =
        Some((std::time::Instant::now(), report));
    Ok(())
}
```
(Confirm `MediaItem.metadata.audio` and `CacheLayout::audio_conform` names against the current `state`/`cache` modules — they are used verbatim in `4a0dda90:commands.rs`. The compiler will flag any drift.)

- [ ] **Step 4: Add the `audio_meter` field to `Backend`**

In `apps/desktop/src-tauri/src/napi_backend.rs`, add the struct field:
```rust
    #[cfg(feature = "jobs")]
    pub(crate) audio_meter: crate::commands::media::AudioMeterState,
```
and in `build_backend`'s `Backend { … }` initializer:
```rust
    #[cfg(feature = "jobs")]
    audio_meter: crate::commands::media::AudioMeterState::default(),
```

- [ ] **Step 5: Add the dispatch arms**

Below the import arms (Task 2, above `other =>`):
```rust
            #[cfg(feature = "jobs")]
            "get_media_thumbnail" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_media_thumbnail(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "get_waveform_peaks" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_waveform_peaks(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "ensure_full_proxy" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::ensure_full_proxy(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "ensure_conform" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::ensure_conform(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "report_audio_meter" => {
                #[derive(serde::Deserialize)]
                struct A { report: crate::commands::media::AudioMeterReport }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::report_audio_meter(self, a.report).await)
            }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs get_waveform_peaks_unknown_media_errors report_audio_meter_stores_snapshot`
Expected: PASS.

- [ ] **Step 7: Full suite green + commit**

```bash
cd apps/desktop/src-tauri && cargo test --lib --features jobs
git add apps/desktop/src-tauri/src/commands/media.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s3a): thumbnail/waveform/ensure-proxy/ensure-conform/audio-meter commands + AudioMeterState"
```

---

## Task 4: `weftcut-media://` protocol + Range + `convertFileSrc`

**Files:**
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/src/electron-compat/tauri-core.ts`
- Test: `apps/desktop/e2e/electron/s3a-protocol.spec.ts` (create)

**Interfaces:**
- Produces: a registered privileged scheme `weftcut-media` + `protocol.handle('weftcut-media', …)` serving local files with Range; `convertFileSrc(absPath) -> "weftcut-media://localhost/<encoded>"`.

- [ ] **Step 1: Write the failing Playwright test**

Create `apps/desktop/e2e/electron/s3a-protocol.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('weftcut-media:// serves a local file with Range', async () => {
  // A 256-byte file of known content.
  const tmp = path.join(os.tmpdir(), `wc-proto-${process.pid}.bin`)
  const buf = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) buf[i] = i
  fs.writeFileSync(tmp, buf)

  const app = await electron.launch({ args: [path.resolve(__dirname, '../../out/main/index.js')] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const url = `weftcut-media://localhost/${encodeURIComponent(tmp)}`
  const result = await page.evaluate(async (u) => {
    const res = await fetch(u, { headers: { Range: 'bytes=10-19' } })
    const ab = await res.arrayBuffer()
    return {
      status: res.status,
      contentRange: res.headers.get('Content-Range'),
      bytes: Array.from(new Uint8Array(ab)),
    }
  }, url)

  expect(result.status).toBe(206)
  expect(result.contentRange).toBe('bytes 10-19/256')
  expect(result.bytes).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

  await app.close()
  fs.rmSync(tmp, { force: true })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npm run napi:build && npm run electron:build && npx playwright test -c playwright.config.ts e2e/electron/s3a-protocol.spec.ts`
Expected: FAIL — the scheme isn't registered, `fetch` rejects / non-206.

- [ ] **Step 3: Register the privileged scheme (before `app.ready`)**

In `apps/desktop/electron/main/index.ts`, after the imports, add `protocol` to the electron import and register the scheme at module top level (must run before `app.whenReady`):
```ts
import { app, BrowserWindow, ipcMain, protocol, net } from 'electron'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'weftcut-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])
```

- [ ] **Step 4: Register the protocol handler (inside `app.whenReady`, after `createWindow`/handlers)**

In the `app.whenReady().then(async () => { … })` body, add:
```ts
  protocol.handle('weftcut-media', async (request) => {
    // URL form: weftcut-media://localhost/<encodeURIComponent(absPath)>
    const u = new URL(request.url)
    const abs = decodeURIComponent(u.pathname.replace(/^\//, ''))
    if (!path.isAbsolute(abs)) {
      return new Response('bad path', { status: 403 })
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('not a file', { status: 404 })

    const total = stat.size
    const range = request.headers.get('Range')
    const headersBase: Record<string, string> = { 'Accept-Ranges': 'bytes' }

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!m) return new Response('bad range', { status: 416 })
      let start = m[1] === '' ? 0 : parseInt(m[1], 10)
      let end = m[2] === '' ? total - 1 : parseInt(m[2], 10)
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        })
      }
      if (end >= total) end = total - 1
      const stream = fs.createReadStream(abs, { start, end })
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...headersBase,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }

    const stream = fs.createReadStream(abs)
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: { ...headersBase, 'Content-Length': String(total) },
    })
  })
```
(If Node's `fs.ReadStream` isn't accepted directly as a `Response` body in this Electron version, wrap it: `import { Readable } from 'node:stream'` and pass `Readable.toWeb(stream)`. Use `net` only if the stream path needs it — `fs.createReadStream` is the simplest and what the test exercises.)

- [ ] **Step 5: Point `convertFileSrc` at the scheme**

In `apps/desktop/src/electron-compat/tauri-core.ts`, replace the `convertFileSrc` body:
```ts
export function convertFileSrc(filePath: string, _protocol?: string): string {
  // Electron custom protocol served by protocol.handle('weftcut-media') in main,
  // with HTTP Range support (lifts the WebView2 asset:// ~1 MB ceiling).
  return `weftcut-media://localhost/${encodeURIComponent(filePath)}`
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/desktop && npm run napi:build && npm run electron:build && npx playwright test -c playwright.config.ts e2e/electron/s3a-protocol.spec.ts`
Expected: PASS (206, `bytes 10-19/256`, bytes `[10..19]`).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/src/electron-compat/tauri-core.ts apps/desktop/e2e/electron/s3a-protocol.spec.ts
git commit -m "migrate(s3a): weftcut-media:// protocol with Range + convertFileSrc shim"
```

---

## Task 5: `dialog:` / `path:` main handlers + window-resize forwarder

**Files:**
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/preload/index.ts`
- Test: `apps/desktop/e2e/electron/s3a-handlers.spec.ts` (create)

**Interfaces:**
- Produces: `ipcMain.handle('dialog:open'|'dialog:save'|'path:join'|'path:tempDir')`; a `resize`/`maximize`/`unmaximize` → `webContents.send('evt:window:resized', …)` forwarder; preload routes `dialog:` channels direct.

- [ ] **Step 1: Write the failing Playwright test**

Create `apps/desktop/e2e/electron/s3a-handlers.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('path:join and path:tempDir round-trip through the bridge', async () => {
  const app = await electron.launch({ args: [path.resolve(__dirname, '../../out/main/index.js')] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const joined = await page.evaluate(() =>
    (window as any).api.invoke('path:join', { parts: ['a', 'b', 'c.txt'] }),
  )
  expect(typeof joined).toBe('string')
  expect(joined.replace(/\\/g, '/')).toBe('a/b/c.txt')

  const tmp = await page.evaluate(() => (window as any).api.invoke('path:tempDir'))
  expect(typeof tmp).toBe('string')
  expect(tmp.length).toBeGreaterThan(0)

  await app.close()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npm run electron:build && npx playwright test -c playwright.config.ts e2e/electron/s3a-handlers.spec.ts`
Expected: FAIL — `path:join` has no handler (rejects).

- [ ] **Step 3: Add the handlers in main**

In `apps/desktop/electron/main/index.ts`, alongside the existing `path:documentDir` handler, add:
```ts
  ipcMain.handle('path:join', (_e, { parts }: { parts: string[] }) => path.join(...parts))
  ipcMain.handle('path:tempDir', () => app.getPath('temp'))

  const { dialog } = require('electron') as typeof import('electron')
  ipcMain.handle('dialog:open', async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string
      multiple?: boolean
      filters?: { name: string; extensions: string[] }[]
      defaultPath?: string
    }
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: o.title,
      defaultPath: o.defaultPath,
      filters: o.filters,
      properties: o.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return o.multiple ? res.filePaths : res.filePaths[0]
  })
  ipcMain.handle('dialog:save', async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: o.title,
      defaultPath: o.defaultPath,
      filters: o.filters,
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })
```
(`dialog` can also be added to the top `electron` import instead of `require`; either is fine.)

- [ ] **Step 4: Add the resize forwarder (inside `createWindow`, after `mainWindow = win`)**

```ts
  const sendResized = () =>
    win.webContents.send('evt:window:resized', { isMaximized: win.isMaximized() })
  win.on('resize', sendResized)
  win.on('maximize', sendResized)
  win.on('unmaximize', sendResized)
```

- [ ] **Step 5: Route `dialog:` channels in preload**

In `apps/desktop/electron/preload/index.ts`, extend the prefix check:
```ts
    if (
      channel.startsWith('window:') ||
      channel.startsWith('path:') ||
      channel.startsWith('dialog:')
    ) {
      return ipcRenderer.invoke(channel, args)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/desktop && npm run electron:build && npx playwright test -c playwright.config.ts e2e/electron/s3a-handlers.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/electron/preload/index.ts apps/desktop/e2e/electron/s3a-handlers.spec.ts
git commit -m "migrate(s3a): dialog:/path: main handlers + window-resize forwarder"
```

---

## Task 6: S3a import gate (Playwright-for-Electron)

The S3a exit gate: import a fixture media file through the full renderer→preload→main→napi bridge and confirm the import command + job pipeline run. The fixture is a small audio/image file (no GPU needed). Uses the generated e2e fixtures.

**Files:**
- Test: `apps/desktop/e2e/electron/s3a-import.spec.ts` (create)

**Interfaces:**
- Consumes: `import_media`, `project_summary`, `import_queue_list` (Tasks 2–3); the `media:job_*` events; e2e fixtures (`apps/desktop/e2e/fixtures/`).

- [ ] **Step 1: Ensure fixtures exist**

Run: `cd apps/desktop/e2e && npm run fixtures`
Expected: fixture media files exist under `apps/desktop/e2e/fixtures/` (the generator prints the paths). Note an image or short audio fixture's absolute path for the test (e.g. a `.png` or `.wav`).

- [ ] **Step 2: Write the import gate test**

Create `apps/desktop/e2e/electron/s3a-import.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Pick a small, real fixture (image → no ffmpeg dependency for the gate).
const FIXTURE = path.resolve(__dirname, '../../e2e/fixtures/pixel.png')

test('import_media adds media to the pool and registers job events', async () => {
  test.skip(!fs.existsSync(FIXTURE), `fixture missing: ${FIXTURE} (run npm run fixtures)`)

  const app = await electron.launch({ args: [path.resolve(__dirname, '../../out/main/index.js')] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Subscribe to media:job_* events BEFORE importing.
  await page.evaluate(() => {
    ;(window as any).__jobEvents = []
    ;(window as any).api.on('media:job_started', (p: unknown) => (window as any).__jobEvents.push(['started', p]))
    ;(window as any).api.on('media:job_complete', (p: unknown) => (window as any).__jobEvents.push(['complete', p]))
  })

  const mediaId = await page.evaluate(
    (f) => (window as any).api.invoke('import_media', { path: f }),
    FIXTURE,
  )
  expect(typeof mediaId).toBe('string')
  expect((mediaId as string).length).toBeGreaterThan(0)

  // The media is now in the pool.
  const summary = await page.evaluate(() => (window as any).api.invoke('project_summary', {}))
  const ids: string[] = (summary.media ?? []).map((m: any) => m.id)
  expect(ids).toContain(mediaId)

  await app.close()
})
```
(If the fixture generator emits a different filename, set `FIXTURE` to it. If `project_summary`'s media list field is named other than `media`, adjust the accessor to match `ProjectSummary` — check `commands/mod.rs`'s `ProjectSummary`/`MediaSummary` shape.)

- [ ] **Step 3: Run the gate**

Run: `cd apps/desktop && npm run napi:build && npm run electron:build && npx playwright test -c playwright.config.ts e2e/electron/s3a-import.spec.ts`
Expected: PASS — `import_media` returns an id; the media appears in `project_summary`.

- [ ] **Step 4: Manual preview verification (record, don't automate)**

Run: `cd apps/desktop && npm run electron:dev`. In the app: open/create a workspace, Import a real **video** file via the menu (Mod+I), wait for the proxy/thumbnail job toasts, drag the clip to the timeline, and scrub — confirm frames render in the Pixi preview (no white/blank). Capture a screenshot to `apps/desktop/electron/s3a-preview.png` for the record (mirrors the S1 `boot.png` convention).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/electron/s3a-import.spec.ts apps/desktop/electron/s3a-preview.png
git commit -m "migrate(s3a): Playwright import gate + manual preview verification"
```

---

## Task 7: Housekeeping + S3a acceptance notes

Fold in the two deferred S2 cleanups and record acceptance.

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/history.rs` (gate the `chrono::Utc` import)
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs` (add the `log:entry` EventSink test)
- Create: `apps/desktop/electron/S3a-NOTES.md`

- [ ] **Step 1: Gate the release-only-warning import in `history.rs`**

In `apps/desktop/src-tauri/src/commands/history.rs`, the `use chrono::Utc;` is only used under `#[cfg(debug_assertions)]`. Gate the import to match its uses:
```rust
#[cfg(debug_assertions)]
use chrono::Utc;
```
Verify a release-style build is warning-free for this item:
Run: `cd apps/desktop/src-tauri && cargo build --lib --features jobs --release 2>&1 | grep -i "unused.*Utc" || echo "no Utc warning"`
Expected: `no Utc warning`.

- [ ] **Step 2: Add the deferred `log:entry` EventSink test**

Add to the `napi_backend.rs` test module (model on the existing bridge tests; assert that a logged action reaches the sink after a workspace is installed). Use the same `new_for_test` + `save_as` flow the S2 persistence test uses:
```rust
    #[tokio::test]
    async fn logged_action_after_workspace_emits_log_entry() {
        let sink = crate::events::VecEventSink::new();
        let b = Backend::new_for_test(std::sync::Arc::new(sink.clone()));
        b.init().await.unwrap();
        // Install a workspace (save_as) so the LogBus slot is live, then emit a log.
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("p.vproj");
        b.dispatch("project_save_as", &serde_json::json!({ "path": proj.to_string_lossy() }).to_string())
            .await
            .unwrap();
        let entry = serde_json::json!({
            "input": { "level": "info", "category": { "kind": "System" }, "source": { "kind": "User" }, "message": "hi" }
        })
        .to_string();
        b.dispatch("log_emit", &entry).await.unwrap();
        // poll-until-timeout (broadcast bridge is async)
        let mut found = false;
        for _ in 0..100 {
            if sink.names().iter().any(|n| n == crate::logs::EVENT_LOG_ENTRY) { found = true; break }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(found, "log:entry reached the sink; saw {:?}", sink.names());
    }
```
(Match `new_for_test`'s real signature and the exact `LogEntryInput` JSON shape `log_emit` expects — copy from the S2 `log_emit`/`prefs.rs` arg struct. `EVENT_LOG_ENTRY` is re-exported from `crate::logs`.)

- [ ] **Step 3: Run the new test + full suite**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs logged_action_after_workspace_emits_log_entry && cargo test --lib --features jobs`
Expected: PASS, 0 failed.

- [ ] **Step 4: Write the acceptance notes**

Create `apps/desktop/electron/S3a-NOTES.md` summarizing: jobs feature on; jobs+import decoupled to EventSink; the 8 media commands wired; `weftcut-media://` protocol live with Range; dialog/path handlers + resize forwarder; the import gate green; manual preview verified (reference `s3a-preview.png`); deferred items (drag-drop import → later; export → S3b; ffmpeg bundling → S6). Note the exact `napi:build --features jobs` requirement.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/history.rs apps/desktop/src-tauri/src/napi_backend.rs apps/desktop/electron/S3a-NOTES.md
git commit -m "migrate(s3a): housekeeping (chrono::Utc gate, log:entry test) + S3a acceptance notes"
```

---

## Self-Review

**Spec coverage:**
- F1 (enable `jobs`) → Task 1. F2 (EventSink decouple of jobs+import) → Task 1. F3 (ffmpeg bootstrap) → Task 1 Step 7. ✓
- A1 (media protocol + Range + convertFileSrc) → Task 4. ✓
- A2 (jobs wired; `enqueue_for_media` re-wire; dispatch arms) → Tasks 2–3 + Task 2 Step 7. ✓
- A3 (dialog/path handlers + resize forwarder) → Task 5. (fs:* handlers are S3b per the spec — not in S3a.) ✓
- A4 (preview runs unchanged) → Task 6 Step 4 manual verification. ✓
- Command surface: all 7 S3a commands + `report_audio_meter` → Tasks 2 (import_media/cancel/queue_list) + 3 (thumbnail/waveform/ensure_full_proxy/ensure_conform/report_audio_meter). ✓
- Deferred S2 cleanups (log:entry test, chrono::Utc gate) → Task 7. ✓
- S3a exit criteria 1–4 → Tasks 2/3 (commands), 1 (unit tests), 6 (import gate + preview). ✓

**Placeholder scan:** Command bodies, dispatch arms, protocol handler, and tests carry full code. The few "match the existing `new_for_test` signature / `ProjectSummary` field name / `MediaItem` literal" notes point at a concrete in-repo source (the neighbouring S2 tests, `commands/mod.rs`, `4a0dda90:commands.rs`) — the compiler/test enforces them; they are not open-ended.

**Type consistency:** `MediaIdArgs { media_id }` (camelCase `mediaId`) reused across import_cancel + the 4 derivative commands; `PathArgs { path }` reused for import_media; `WaveformPeaks { peaks, peaks_per_second: u32 }` matches `waveform::PEAKS_PER_SECOND: u32`; `enqueue_for_media`/`enqueue_full_proxy`/`enqueue_conform` first param `Arc<dyn EventSink>` consistent between Task 1 (definition) and Tasks 2–3 (callers); `ImportQueue::new(events, log_slot)` consistent between Task 1 (def) and Task 2 (build_backend caller); `convertFileSrc` URL form matches the protocol handler's `URL` parse and the test in Task 4.
