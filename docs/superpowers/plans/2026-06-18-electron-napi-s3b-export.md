# S3b — Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under Electron, run an end-to-end video export — Pixi/WebCodecs worker → fMP4-to-disk (8-bit) or loopback-WebSocket video sink (10-bit) → Rust audio-only mix + ffmpeg mux/transcode → a valid output file for H.264, AV1, HEVC, and 10-bit — through the napi `Backend`, with the renderer unchanged behind the S1/S2/S3a compat shims.

**Architecture:** Turn on the Rust `export` cargo feature in the napi addon and decouple `export/mod.rs` + `export/videosink.rs` from `tauri::AppHandle`/`State`/`#[tauri::command]` onto the S2 `EventSink` + two `Backend`-held stores (`VideoSinkState`, `HwEncoderCache`). Re-home the export commands into `commands/export.rs` (`&Backend` fns) + add dispatcher arms. Add Electron-main `fs:*` handlers (incl. append-write for the fMP4 stream) + preload routing. Port the export + media-conformance e2e gates from tauri-driver/WebdriverIO to Playwright-for-Electron via a new driver helper. No `src/**` app-code edits — only the sanctioned `electron-compat/` shim layer (`plugin-fs` options forwarding) and `electron/` main/preload + `electron.vite.config.ts`.

**Tech Stack:** Rust (napi-rs v3, tokio, ffmpeg-sidecar, tungstenite, serde_json), Electron 40 (`ipcMain`, `protocol.handle` from S3a), Playwright-for-Electron, the existing React/Vite/PixiJS renderer (unchanged), the engine-agnostic `media_conformance` Rust analyzer bin (reused as-is).

## Global Constraints

- **Branch:** `migration/electron-napi`. Never commit to `main`. **Stage by explicit path** (parallel sessions edit this checkout); re-check `git status` before each commit.
- **No `src/**` app-code edits.** The only renderer-side change is the `plugin-fs` `writeFile` options-forwarding in `apps/desktop/src/electron-compat/plugin-fs.ts` (sanctioned compat layer). Everything else is additive under `apps/desktop/electron/`, `apps/desktop/src-tauri/`, `apps/desktop/e2e/electron/`, or `apps/desktop/electron.vite.config.ts`.
- **S3b enables the `export` cargo feature** (alongside `jobs`, already on from S3a). `export` transitively shares `audio`/`ffmpeg`/`io::probe` (gated `any(jobs,export)`), already compiled. `cloud`/`mcp`/`motifs` stay OFF.
- **Event names unchanged** (`export:transcode_progress`) so the renderer's `listen<number>(EXPORT_TRANSCODE_PROGRESS)` + the `evt:<name>` bridge work untouched. The Tauri `app.emit(name, pct: f64)` payload was the bare number; the EventSink replacement emits `serde_json::json!(pct)` (a JSON number) → identical wire payload (parity).
- **WS is the sole production video-sink transport** (decision D2/B2). `export_video_sink_write` (the raw-IPC byte fallback, `tauri::ipc::Request`) is **NOT** ported into the JSON dispatcher — it is deleted from `videosink.rs`. The renderer only reaches it on a WS-connect failure (Chromium WS is reliable); if WS fails the 10-bit export fails (spec-accepted). A `Buffer`-typed napi method is only added later if WS proves insufficient.
- **EventSink contract:** `trait EventSink { fn emit(&self, event: &str, payload: serde_json::Value); }` (`src-tauri/src/events.rs`). `Backend.events: Arc<dyn EventSink>` (Clone).
- **Backend accessors:** `backend.project()? -> &ProjectHandle`; `backend.cache: CacheLayout` (Clone); `backend.events: Arc<dyn EventSink>` (Clone); after this plan `backend.video_sink: VideoSinkState` + `backend.hw_encoder: HwEncoderCache` (both `#[cfg(feature="export")]`).
- **Dispatcher:** `Backend::dispatch(cmd, args)` at `src-tauri/src/napi_backend.rs:225`; the `other => Err("unavailable…")` arm is at line 444; `ser<T: Serialize>(Result<T,String>) -> Result<String,String>` helper at line 450. New arms go just above the `other =>` arm (after the S3a `jobs` arms).
- **Build commands:** addon `cd apps/desktop && npm run napi:build` (S3b appends `,export` → `--features jobs,export`); Rust tests `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export`; e2e build `$env:VITE_WEFTCUT_E2E='1'; npm run electron:build` (PowerShell — bakes the `__weftcutTest` hook surface); a single e2e spec runs via `npx playwright test -c playwright.config.ts e2e/electron/<spec>` (npm/npx drop positional spec args on Windows — call playwright directly).
- **e2e media fixtures:** `WEFTCUT_TEST_MEDIA` env points at the fixture media dir (else `e2e/fixtures/media`). Specs `test.skip(...)` when a fixture is missing. The `media_conformance` analyzer is invoked via `analyze()` in `e2e/lib/analyze.mjs` (shells `cargo run --bin media_conformance`) — engine-agnostic, reused unchanged.

---

## File Structure

- `apps/desktop/package.json` — `napi:build` script: `--features jobs` → `--features jobs,export`
- `apps/desktop/src-tauri/src/export/mod.rs` — MODIFY: drop `tauri::AppHandle`; `export_audio_only` loses `_app`; `transcode_and_mux` `&AppHandle`→`&Arc<dyn EventSink>`
- `apps/desktop/src-tauri/src/export/videosink.rs` — MODIFY: drop `tauri::State`/`#[tauri::command]`; `State<>`→`&` refs; `tauri::async_runtime`→`tokio`; delete `export_video_sink_write`
- `apps/desktop/src-tauri/src/napi_backend.rs` — MODIFY: `video_sink`/`hw_encoder` fields; export dispatch arms; Rust tests
- `apps/desktop/src-tauri/src/commands/export.rs` — CREATE: `export_project_audio_only`/`mux_export`/`ensure_export_audio_conform` (`&Backend` fns) + `TranscodeSpec`
- `apps/desktop/src-tauri/src/commands/mod.rs` — MODIFY: `#[cfg(feature="export")] pub mod export;` + `ExportAudioOnlyArgs`/`MuxExportArgs`/`ExportConformArgs`
- `apps/desktop/electron/main/index.ts` — MODIFY: `fs:*` handlers (writeFile append, writeTextFile, readFile, remove, exists, readDir)
- `apps/desktop/electron/preload/index.ts` — MODIFY: route `fs:` channels direct
- `apps/desktop/src/electron-compat/plugin-fs.ts` — MODIFY: `writeFile` forwards `{ append }`
- `apps/desktop/electron.vite.config.ts` — MODIFY: renderer `define` for `import.meta.env.VITE_WEFTCUT_E2E`
- `apps/desktop/e2e/electron/helpers/driver.ts` — CREATE: Playwright `launchApp`/`newProject`/`driveExport`/`waitForHook`
- `apps/desktop/e2e/electron/s3b-fs.spec.ts` — CREATE: fs append/truncate round-trip gate
- `apps/desktop/e2e/electron/conformance.spec.ts` — CREATE: H.264 export conformance gate (port)
- `apps/desktop/e2e/electron/export_eos_tail.spec.ts` — CREATE: eos-tail regression (port)
- `apps/desktop/e2e/electron/export_overlap_same_source.spec.ts` — CREATE: overlap regression (port)
- `apps/desktop/e2e/electron/export_codecs.spec.ts` — CREATE: AV1 + HEVC + 10-bit smoke (port of 10bit/content-modes)
- `apps/desktop/electron/S3b-NOTES.md` — CREATE: acceptance notes

---

## Task 1: Enable `export`; decouple `export/mod.rs` + `videosink.rs` from Tauri; add Backend fields

Enabling `export` compiles `export/mod.rs`, `videosink.rs`, `hwencoder.rs` for the first time since S2 stripped Tauri — they still reference `tauri::AppHandle`/`State`/`#[tauri::command]`/`tauri::ipc`, which no longer exist. The feature flip + decouple + the two new `Backend` stores are one inseparable build-green unit. No command wiring yet.

**Files:**
- Modify: `apps/desktop/package.json` (script)
- Modify: `apps/desktop/src-tauri/src/export/mod.rs`
- Modify: `apps/desktop/src-tauri/src/export/videosink.rs`
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs` (struct + `build_backend` only)

**Interfaces:**
- Produces (export/mod.rs): `export_audio_only(project: &Project, output: &Path, audio: &AudioEncodeSpec, window_us: Option<(i64,i64)>) -> Result<bool>`; `transcode_and_mux(events: &Arc<dyn EventSink>, encoder: &str, codec: TargetCodec, bitrate: u64, cbr: bool, gop: u64, duration_us: i64, video_path: &Path, audio_path: &Path, output: &Path) -> Result<()>`. `mux_to_file` unchanged.
- Produces (videosink.rs): `export_video_sink_start(state: &VideoSinkState, hw: &HwEncoderCache, args: VideoSinkStartArgs) -> Result<VideoSinkStartReply,String>`; `export_video_sink_finish(state: &VideoSinkState) -> Result<SinkStats,String>`; `export_video_sink_cancel(state: &VideoSinkState) -> Result<(),String>`.
- Produces (Backend): `video_sink: crate::export::videosink::VideoSinkState`, `hw_encoder: crate::export::HwEncoderCache` (both `#[cfg(feature="export")]`).

- [ ] **Step 1: Confirm the build fails before decoupling**

In `apps/desktop/package.json`, change the `napi:build` script's `--features jobs` to `--features jobs,export`:
```json
"napi:build": "napi build --platform --release --manifest-path src-tauri/Cargo.toml --output-dir src-tauri --features jobs,export",
```
Run: `cd apps/desktop && npm run napi:build`
Expected: FAIL — compile errors in `export`/`videosink` like `cannot find type AppHandle`, `use of undeclared crate or module tauri`, `cannot find type State`, `cannot find attribute command`. This is the starting state.

- [ ] **Step 2: Decouple `export/mod.rs` — imports + `export_audio_only` + `transcode_and_mux`**

In `apps/desktop/src-tauri/src/export/mod.rs`:

Replace the tauri import (line 19):
```rust
use tauri::AppHandle;
```
with:
```rust
use std::sync::Arc;

use crate::events::EventSink;
```

Remove the `_app: AppHandle,` first parameter of `export_audio_only` (lines 61–69 region). The new signature:
```rust
pub async fn export_audio_only(
    project: &Project,
    output: &Path,
    audio: &AudioEncodeSpec,
    window_us: Option<(i64, i64)>,
) -> Result<bool> {
    mix_and_encode(project, output, audio, window_us).await
}
```
(Delete the `/// \`_app\` is taken to keep…` doc lines; the body is unchanged.)

In `transcode_and_mux`, change the first param `app: &AppHandle` → `events: &Arc<dyn EventSink>`. Remove `use tauri::Emitter;` (the line inside the fn). Replace the progress-task capture + emit:
```rust
        let app_for_progress = app.clone();
```
with:
```rust
        let events_for_progress = events.clone();
```
and inside that task:
```rust
                    let _ = app_for_progress.emit(EVENT_TRANSCODE_PROGRESS, pct);
```
with:
```rust
                    events_for_progress.emit(EVENT_TRANSCODE_PROGRESS, serde_json::json!(pct));
```
and the final line:
```rust
    let _ = app.emit(EVENT_TRANSCODE_PROGRESS, 1.0_f64);
```
with:
```rust
    events.emit(EVENT_TRANSCODE_PROGRESS, serde_json::json!(1.0));
```

- [ ] **Step 3: Decouple `videosink.rs` — imports + the three command fns**

In `apps/desktop/src-tauri/src/export/videosink.rs`:

Remove the tauri import (line 16):
```rust
use tauri::State;
```

`export_video_sink_start` (line ~335): remove `#[tauri::command]`; change the two `State` params to plain refs:
```rust
pub async fn export_video_sink_start(
    state: &VideoSinkState,
    hw: &super::hwencoder::HwEncoderCache,
    args: VideoSinkStartArgs,
) -> Result<VideoSinkStartReply, String> {
```
(The body is unchanged — `state.0`, `reclaim_stale_sink(&state.0)`, `hw.encoder_for_10bit(codec)` all work on `&VideoSinkState`/`&HwEncoderCache`.)

`export_video_sink_finish` (line ~475): remove `#[tauri::command]`; `state: State<'_, VideoSinkState>` → `state: &VideoSinkState`; change `tauri::async_runtime::spawn_blocking(...)` → `tokio::task::spawn_blocking(...)`:
```rust
pub async fn export_video_sink_finish(
    state: &VideoSinkState,
) -> Result<SinkStats, String> {
```
```rust
    let join_result = tokio::task::spawn_blocking(move || {
        join.join().unwrap_or_else(|_| Err("sink thread panicked".into()))
    })
    .await;
```

`export_video_sink_cancel` (line ~511): remove `#[tauri::command]`; `state: State<'_, VideoSinkState>` → `state: &VideoSinkState`:
```rust
pub async fn export_video_sink_cancel(
    state: &VideoSinkState,
) -> Result<(), String> {
```

- [ ] **Step 4: Delete the raw-IPC `export_video_sink_write`**

In `apps/desktop/src-tauri/src/export/videosink.rs`, delete the entire `export_video_sink_write` fn (the `#[tauri::command] pub fn export_video_sink_write(request: tauri::ipc::Request<'_>, …)` block, lines ~527–566, including its `/// IPC fallback:` doc comment). Per B2, WS is the sole transport; this is not ported. The `SinkShared` fields `ipc_bytes`/`ipc_frames`/`last_write_ms` stay (still read in `run_ws_sink`'s accept loop — they read as 0, which makes a clientless sink abort after 30 s, the correct "crashed worker" behavior).

- [ ] **Step 5: Add the `video_sink` + `hw_encoder` fields to `Backend` + construct them**

In `apps/desktop/src-tauri/src/napi_backend.rs`, add to the `Backend` struct after the `audio_meter` field (line 38):
```rust
    #[cfg(feature = "export")]
    pub(crate) video_sink: crate::export::videosink::VideoSinkState,
    #[cfg(feature = "export")]
    pub(crate) hw_encoder: crate::export::HwEncoderCache,
```
In `build_backend`'s `Backend { … }` initializer, after the `audio_meter:` line (line 86):
```rust
        #[cfg(feature = "export")]
        video_sink: crate::export::videosink::VideoSinkState::default(),
        #[cfg(feature = "export")]
        hw_encoder: crate::export::HwEncoderCache::default(),
```
(`VideoSinkState` derives `Default`; `HwEncoderCache` impls `Default`.)

- [ ] **Step 6: Build the addon with `jobs,export`**

Run: `cd apps/desktop && npm run napi:build`
Expected: PASS — `@weftcut/core` builds; no `AppHandle`/`tauri`/`State`/`command`/`ipc` errors.

- [ ] **Step 7: Run the Rust unit tests with `jobs,export`**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export`
Expected: PASS — the S3a suite PLUS the newly compiled `export`/`hwencoder`/`videosink` tests (`export::tests::video_encode_args_*`, `hvc1_tag_only_for_hevc_in_mp4_mov`, `mux_args_*`, `hwencoder::tests::tenbit_args_per_encoder`, `videosink::tests::reclaim_*`; the ffmpeg-gated `mix_and_encode_two_layer_roundtrip` self-skips without ffmpeg on PATH). 0 failed.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src-tauri/src/export/mod.rs apps/desktop/src-tauri/src/export/videosink.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s3b): enable export feature; decouple export+videosink from Tauri (AppHandle/State/command -> EventSink + Backend stores)"
```

---

## Task 2: Audio-only / mux / conform export commands + dispatch arms

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/export.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs` (`pub mod export;` + 3 arg structs)
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs` (dispatch arms + 1 test)

**Interfaces:**
- Consumes: `Backend::project()`, `backend.cache`, `backend.events`, `backend.hw_encoder` (Task 1), `export::{export_audio_only, mux_to_file, transcode_and_mux, TargetCodec, AudioEncodeSpec}`, `jobs::enqueue_conform`, `audio::mix::conform_waiting_media`.
- Produces: `commands::export::{export_project_audio_only, mux_export, ensure_export_audio_conform}` + `commands::export::TranscodeSpec`; dispatch arms `export_project_audio_only`/`mux_export`/`ensure_export_audio_conform`.

- [ ] **Step 1: Write the failing test (no-ffmpeg conform path)**

Add to the `napi_backend.rs` test module (the `#[cfg(test)] mod tests` block):
```rust
    /// Blank project has no audio layers, so the export-audio gate returns an
    /// empty waiting list with no ffmpeg involvement — proves the arm is wired.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn ensure_export_audio_conform_blank_is_empty() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let out = b
            .dispatch("ensure_export_audio_conform", r#"{"startUs":0,"endUs":1000000}"#)
            .await
            .unwrap();
        assert_eq!(out, "[]", "blank project has no audio layers to conform");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export ensure_export_audio_conform_blank_is_empty`
Expected: FAIL — `ensure_export_audio_conform` hits the `unavailable` dispatch arm (the assert sees the error string, not `[]`), or won't compile because `commands::export` doesn't exist yet.

- [ ] **Step 3: Create `commands/export.rs`**

Create `apps/desktop/src-tauri/src/commands/export.rs`:
```rust
//! S3b export commands — audio-only mix/encode, final mux/transcode, and the
//! export-audio conform gate. Re-homed from the Tauri `commands.rs` onto the
//! napi `Backend`. Gated behind `export`. The WS video-sink commands live in
//! `export::videosink` and are dispatched directly (they need only the two
//! Backend stores, not a project snapshot).

use std::path::PathBuf;

use crate::export::{self, AudioEncodeSpec, TargetCodec};
use crate::napi_backend::Backend;

/// Transcode spec for the ffmpeg export path. Absent ⇒ stream-copy mux.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeSpec {
    pub video_codec: String, // "h264" | "hevc" | "av1" | "vp9"
    pub bitrate: u64,
    pub cbr: bool,
    pub duration_us: i64,
    pub gop: u64,
    #[serde(default)]
    pub software: bool,
}

/// Audio-only export → `output_path` (.m4a AAC / .mka Opus). The mix is Rust
/// (sample-accurate over conform PCM); ffmpeg is the encode tail. Emits no
/// events; the JS orchestrator drives the panel.
pub async fn export_project_audio_only(
    backend: &Backend,
    output_path: String,
    audio: AudioEncodeSpec,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<bool, String> {
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let project = (*snap).clone();
    let path = PathBuf::from(output_path);
    let window = match (start_us, end_us) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    export::export_audio_only(&project, &path, &audio, window)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Mux `video_path` (+ optional `audio_path`) into `output_path`. With no
/// `transcode`, stream-copies (`-c copy`); with one, re-encodes the video to
/// the target codec (HW-first via the cached probe, software fallback) and
/// emits `export:transcode_progress`. Container = the output extension.
pub async fn mux_export(
    backend: &Backend,
    video_path: String,
    audio_path: String,
    output_path: String,
    transcode: Option<TranscodeSpec>,
) -> Result<(), String> {
    let video = PathBuf::from(video_path);
    let audio = PathBuf::from(audio_path);
    let out = PathBuf::from(output_path);
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create output dir {}: {e}", parent.display()))?;
        }
    }
    match transcode {
        None => export::mux_to_file(&video, &audio, &out)
            .await
            .map_err(|e| format!("{e:#}")),
        Some(spec) => {
            let codec = TargetCodec::parse(&spec.video_codec)
                .ok_or_else(|| format!("unknown codec {}", spec.video_codec))?;
            let encoder: String = if spec.software {
                codec.software_encoder().to_string()
            } else {
                (*backend.hw_encoder.encoder_for(codec).await).clone()
            };
            export::transcode_and_mux(
                &backend.events,
                &encoder,
                codec,
                spec.bitrate,
                spec.cbr,
                spec.gop,
                spec.duration_us,
                &video,
                &audio,
                &out,
            )
            .await
            .map_err(|e| format!("{e:#}"))
        }
    }
}

/// Export-readiness audio gate: media ids of audible in-window audio layers
/// whose conform cache is absent/invalid, each with a conform job kicked.
/// Selection mirrors the mix plan exactly (mute/solo/lock/window).
pub async fn ensure_export_audio_conform(
    backend: &Backend,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<Vec<String>, String> {
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let window = match (start_us, end_us) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    let waiting = crate::audio::mix::conform_waiting_media(&snap, window);
    for id in &waiting {
        let Some(item) = snap.media_pool.get(id).cloned() else {
            continue;
        };
        crate::jobs::enqueue_conform(
            backend.events.clone(),
            backend.cache.clone(),
            handle.clone(),
            item,
        );
    }
    Ok(waiting.iter().map(|u| u.to_string()).collect())
}
```

- [ ] **Step 4: Register the module + arg structs**

In `apps/desktop/src-tauri/src/commands/mod.rs`, add near the S3a `#[cfg(feature = "jobs")] pub mod media;` line:
```rust
#[cfg(feature = "export")]
pub mod export;
```
and add the three arg structs near `MediaIdArgs`:
```rust
#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudioOnlyArgs {
    pub output_path: String,
    pub audio: crate::export::AudioEncodeSpec,
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxExportArgs {
    pub video_path: String,
    pub audio_path: String,
    pub output_path: String,
    pub transcode: Option<crate::commands::export::TranscodeSpec>,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConformArgs {
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}
```

- [ ] **Step 5: Add the dispatch arms**

In `apps/desktop/src-tauri/src/napi_backend.rs`, just above the `other =>` arm (line 444), after the S3a `jobs` arms:
```rust
            #[cfg(feature = "export")]
            "export_project_audio_only" => {
                let a: crate::commands::ExportAudioOnlyArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::export_project_audio_only(self, a.output_path, a.audio, a.start_us, a.end_us).await)
            }
            #[cfg(feature = "export")]
            "mux_export" => {
                let a: crate::commands::MuxExportArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::mux_export(self, a.video_path, a.audio_path, a.output_path, a.transcode).await)
            }
            #[cfg(feature = "export")]
            "ensure_export_audio_conform" => {
                let a: crate::commands::ExportConformArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::ensure_export_audio_conform(self, a.start_us, a.end_us).await)
            }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export ensure_export_audio_conform_blank_is_empty`
Expected: PASS.

- [ ] **Step 7: Full suite green + commit**

```bash
cd apps/desktop/src-tauri && cargo test --lib --features jobs,export
```
Expected: PASS, 0 failed. Then:
```bash
git add apps/desktop/src-tauri/src/commands/export.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s3b): export audio-only/mux/conform commands + dispatch arms"
```

---

## Task 3: Video-sink dispatch arms (start / finish / cancel)

**Files:**
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs` (3 dispatch arms + 1 test)

**Interfaces:**
- Consumes: `backend.video_sink`, `backend.hw_encoder` (Task 1); `export::videosink::{export_video_sink_start, export_video_sink_finish, export_video_sink_cancel, VideoSinkStartArgs, VideoSinkStartReply, SinkStats}`.
- Produces: dispatch arms `export_video_sink_start` / `export_video_sink_finish` / `export_video_sink_cancel`. (`export_video_sink_write` deliberately remains on the `unavailable` arm — see B2.)

- [ ] **Step 1: Write the failing test (discard-mode start, no ffmpeg)**

Add to the `napi_backend.rs` test module:
```rust
    /// "discard" mode binds the loopback listener WITHOUT spawning ffmpeg, so
    /// this exercises the decoupled sink end-to-end through dispatch with no
    /// ffmpeg dependency: start returns a bound port + token, cancel clears it.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn video_sink_discard_start_returns_port_then_cancel() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let start_args = serde_json::json!({
            "args": {
                "mode": "discard", "width": 64, "height": 64,
                "fpsNum": 30, "fpsDen": 1, "codec": "hevc",
                "bitrate": 1_000_000, "cbr": false, "gop": 30,
                "software": false, "outputPath": ""
            }
        })
        .to_string();
        let reply = b.dispatch("export_video_sink_start", &start_args).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert!(v["port"].as_u64().unwrap() > 0, "discard sink returns a bound port, got {reply}");
        assert!(!v["token"].as_str().unwrap().is_empty(), "discard sink returns a token");
        let cancel = b.dispatch("export_video_sink_cancel", "{}").await.unwrap();
        assert_eq!(cancel, "null", "cancel returns unit/null");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export video_sink_discard_start_returns_port_then_cancel`
Expected: FAIL — both commands hit the `unavailable` arm.

- [ ] **Step 3: Add the dispatch arms**

In `apps/desktop/src-tauri/src/napi_backend.rs`, below the Task 2 export arms (above `other =>`):
```rust
            #[cfg(feature = "export")]
            "export_video_sink_start" => {
                #[derive(serde::Deserialize)]
                struct A {
                    args: crate::export::videosink::VideoSinkStartArgs,
                }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::export::videosink::export_video_sink_start(&self.video_sink, &self.hw_encoder, a.args).await)
            }
            #[cfg(feature = "export")]
            "export_video_sink_finish" => {
                ser(crate::export::videosink::export_video_sink_finish(&self.video_sink).await)
            }
            #[cfg(feature = "export")]
            "export_video_sink_cancel" => {
                ser(crate::export::videosink::export_video_sink_cancel(&self.video_sink).await)
            }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export video_sink_discard_start_returns_port_then_cancel`
Expected: PASS.

- [ ] **Step 5: Full suite green + commit**

```bash
cd apps/desktop/src-tauri && cargo test --lib --features jobs,export
git add apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s3b): video-sink dispatch arms (start/finish/cancel; WS-only per B2)"
```

---

## Task 4: `fs:*` main handlers + preload routing + `plugin-fs` options forwarding

The export streams the fMP4 to disk via `writeFile(path, bytes, { append: true })` (App.tsx:1387). The current `fs:` channel routes to the napi dispatcher (→ `unavailable`), and the shim drops the `append` option. Add Node-side `fs:*` handlers, route `fs:` direct in preload, and forward `{ append }` from the shim. Also covers the renderer-used `fs:remove`/`fs:exists`/`fs:readDir`/`fs:readFile`/`fs:writeTextFile` (App.tsx + e2eHook + the export hook's `exists` post-check).

**Files:**
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/preload/index.ts`
- Modify: `apps/desktop/src/electron-compat/plugin-fs.ts`
- Test: `apps/desktop/e2e/electron/s3b-fs.spec.ts` (create)

**Interfaces:**
- Produces: `ipcMain.handle('fs:writeFile'|'fs:writeTextFile'|'fs:readFile'|'fs:remove'|'fs:exists'|'fs:readDir')`; preload routes `fs:` direct; `plugin-fs.writeFile(path, data, { append })` forwards `append`.

- [ ] **Step 1: Write the failing Playwright test**

Create `apps/desktop/e2e/electron/s3b-fs.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

test('fs:writeFile honors append vs truncate through the bridge', async () => {
  const tmp = path.join(os.tmpdir(), `wc-fs-${process.pid}.bin`)
  fs.rmSync(tmp, { force: true })

  const app = await electron.launch({ args: [MAIN] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Truncate-write [1,2,3], then append [4,5] — through window.api.invoke.
  await page.evaluate(async (p) => {
    await (window as any).api.invoke('fs:writeFile', { path: p, data: new Uint8Array([1, 2, 3]), append: false })
    await (window as any).api.invoke('fs:writeFile', { path: p, data: new Uint8Array([4, 5]), append: true })
  }, tmp)
  expect(Array.from(fs.readFileSync(tmp))).toEqual([1, 2, 3, 4, 5])

  // exists → true; remove → exists false.
  const existsBefore = await page.evaluate((p) => (window as any).api.invoke('fs:exists', { path: p }), tmp)
  expect(existsBefore).toBe(true)
  await page.evaluate((p) => (window as any).api.invoke('fs:remove', { path: p }), tmp)
  expect(fs.existsSync(tmp)).toBe(false)

  await app.close()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npm run electron:build && npx playwright test -c playwright.config.ts e2e/electron/s3b-fs.spec.ts`
Expected: FAIL — `fs:writeFile` has no handler (routes to the napi dispatcher → `unavailable`), so the truncate/append assertion fails.

- [ ] **Step 3: Add the `fs:*` handlers in main**

In `apps/desktop/electron/main/index.ts`, alongside the existing `path:`/`dialog:` handlers (after the `dialog:save` handler, before the `protocol.handle('weftcut-media', …)` block):
```ts
  ipcMain.handle(
    'fs:writeFile',
    (_e, { path: p, data, append }: { path: string; data: Uint8Array; append?: boolean }) => {
      const buf = Buffer.from(data)
      if (append) fs.appendFileSync(p, buf)
      else fs.writeFileSync(p, buf)
    },
  )
  ipcMain.handle('fs:writeTextFile', (_e, { path: p, data }: { path: string; data: string }) => {
    fs.writeFileSync(p, data, 'utf8')
  })
  ipcMain.handle('fs:readFile', (_e, { path: p }: { path: string }) => fs.readFileSync(p))
  ipcMain.handle('fs:remove', (_e, { path: p }: { path: string }) => {
    fs.rmSync(p, { force: true, recursive: true })
  })
  ipcMain.handle('fs:exists', (_e, { path: p }: { path: string }) => fs.existsSync(p))
  ipcMain.handle('fs:readDir', (_e, { path: p }: { path: string }) =>
    fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })),
  )
```
(`fs` is already imported at the top of the file as `import fs from 'node:fs'`. `fs:readFile` returns a Node `Buffer`, which is a `Uint8Array` subclass — the shim's cast holds.)

- [ ] **Step 4: Route `fs:` channels direct in preload**

In `apps/desktop/electron/preload/index.ts`, extend the prefix check:
```ts
    if (
      channel.startsWith('window:') ||
      channel.startsWith('path:') ||
      channel.startsWith('dialog:') ||
      channel.startsWith('fs:')
    ) {
      return ipcRenderer.invoke(channel, args)
    }
```

- [ ] **Step 5: Forward `{ append }` from the `plugin-fs` shim**

In `apps/desktop/src/electron-compat/plugin-fs.ts`, change `writeFile` to forward the append option:
```ts
export async function writeFile(
  path: string,
  data: Uint8Array,
  opts?: { append?: boolean },
): Promise<void> {
  await window.api.invoke('fs:writeFile', { path, data, append: opts?.append ?? false })
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/desktop && npm run electron:build && npx playwright test -c playwright.config.ts e2e/electron/s3b-fs.spec.ts`
Expected: PASS (`[1,2,3,4,5]`; exists true→false).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/electron/preload/index.ts apps/desktop/src/electron-compat/plugin-fs.ts apps/desktop/e2e/electron/s3b-fs.spec.ts
git commit -m "migrate(s3b): fs:* main handlers (append write) + preload routing + plugin-fs options forwarding"
```

---

## Task 5: E2E build flag + Playwright driver helper + H.264 export conformance gate

The export e2e specs drive `window.__weftcutTest` hooks (`newProjectAndEnter`, `exportClip`/`exportTimeline`) — mounted only when `import.meta.env.VITE_WEFTCUT_E2E === "1"` (`main.tsx:112`). The electron build doesn't set it. This task wires the flag, builds the reusable Playwright driver helper (the linchpin for all ported export specs), and ports the first/core gate: H.264 import→export frame-alignment conformance.

**Files:**
- Modify: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/e2e/electron/helpers/driver.ts`
- Test: `apps/desktop/e2e/electron/conformance.spec.ts` (create)

**Interfaces:**
- Consumes: `export_project_audio_only`/`mux_export`/`ensure_export_audio_conform` (Task 2), `fs:*` (Task 4), the `weftcut-media://` protocol + media commands (S3a), `analyze()` from `e2e/lib/analyze.mjs` (reused).
- Produces: `helpers/driver.ts` exporting `MAIN`, `launchApp()`, `waitForHook(page,name)`, `newProject(page,opts)`, `driveExport(page,args,opts)`; the renderer build honors `VITE_WEFTCUT_E2E`.

- [ ] **Step 1: Wire the E2E flag into the renderer build**

In `apps/desktop/electron.vite.config.ts`, add a `define` to the `renderer` section (a textual replacement is deterministic and shell-agnostic; the renderer reads `import.meta.env.VITE_WEFTCUT_E2E`):
```ts
  renderer: {
    // …existing root/plugins/resolve/build/server…
    define: {
      'import.meta.env.VITE_WEFTCUT_E2E': JSON.stringify(
        process.env.VITE_WEFTCUT_E2E === '1' ? '1' : '0',
      ),
    },
  },
```
(Place `define` as a sibling of the existing `plugins`/`resolve` keys inside `renderer`.)

- [ ] **Step 2: Create the Playwright driver helper**

Create `apps/desktop/e2e/electron/helpers/driver.ts`:
```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/// Built Electron main entry. Helpers live at e2e/electron/helpers; the build
/// output is apps/desktop/out/main/index.js → three levels up.
export const MAIN = path.resolve(__dirname, '../../../out/main/index.js')

export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [MAIN] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/// Wait until window.__weftcutTest[name] is a function (the hook surface mounts
/// async after the editor loads). Requires a VITE_WEFTCUT_E2E=1 build.
export async function waitForHook(page: Page, name: string, timeout = 30000): Promise<void> {
  await page.waitForFunction(
    (n) => typeof (window as unknown as { __weftcutTest?: Record<string, unknown> }).__weftcutTest?.[n] === 'function',
    name,
    { timeout },
  )
}

/// Create a workspace + enter the editor via the bootstrap hook.
export async function newProject(
  page: Page,
  opts: {
    parentFolder: string
    name: string
    canvas: { width: number; height: number; fpsNum: number; fpsDen: number }
  },
): Promise<void> {
  await waitForHook(page, 'newProjectAndEnter')
  const r = (await page.evaluate(
    (o) =>
      (window as any).__weftcutTest
        .newProjectAndEnter({ parentFolder: o.parentFolder, name: o.name, canvas: o.canvas })
        .then(() => ({ ok: true }))
        .catch((e: unknown) => ({ ok: false, error: String(e) })),
    opts,
  )) as { ok: boolean; error?: string }
  if (!r.ok) throw new Error('newProjectAndEnter failed: ' + r.error)
}

export interface DriveResult {
  done: { ok: boolean; error?: string }
  lastKind: string | null
  lastDetail: string | null
}

/// Fire-and-forget an export hook, then poll window.__e2eExportDone to
/// settlement. Mirrors e2e/helpers/export.mjs::driveExport for Playwright.
/// `hook` defaults to "exportClip"; pass "exportTimeline" for the timeline path.
export async function driveExport(
  page: Page,
  args: Record<string, unknown>,
  opts: { hook?: string; timeout?: number } = {},
): Promise<DriveResult> {
  const hook = opts.hook ?? 'exportClip'
  const timeout = opts.timeout ?? 170000
  await waitForHook(page, hook)
  await page.evaluate(
    ({ h, a }) => {
      ;(window as any).__e2eExportDone = null
      ;(window as any).__weftcutTest[h](a)
        .then(() => {
          ;(window as any).__e2eExportDone = { ok: true }
        })
        .catch((e: unknown) => {
          ;(window as any).__e2eExportDone = { ok: false, error: String(e) }
        })
    },
    { h: hook, a: args },
  )
  const handle = await page.waitForFunction(() => (window as any).__e2eExportDone, undefined, {
    timeout,
    polling: 1000,
  })
  const done = (await handle.jsonValue()) as { ok: boolean; error?: string }
  const st = (await page.evaluate(() => {
    const s = (window as any).__weftcutExportState
    return { kind: s?.kind ?? null, detail: s?.detail ?? null }
  })) as { kind: string | null; detail: string | null }
  return { done, lastKind: st.kind, lastDetail: st.detail }
}
```

- [ ] **Step 3: Port the conformance gate**

Create `apps/desktop/e2e/electron/conformance.spec.ts`:
```ts
import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// analyze() shells `cargo run --bin media_conformance` — engine-agnostic; reused as-is.
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps.mp4')
const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-electron-out.mp4')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-electron-proj')

test('H.264 import -> export stays frame-aligned with low loss (Electron)', async () => {
  test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
  test.setTimeout(220000)
  mkdirSync(PROJECT_PARENT, { recursive: true })
  rmSync(OUTPUT, { force: true })

  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-' + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    const r = await driveExport(page, { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT })
    if (!r.done.ok) throw new Error('exportClip failed: ' + r.done.error)

    // Frame alignment (strict) + app-only loss (loose 0.80 floor) at interior frames.
    const SSIM_FLOOR = 0.8
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150, 270], ssimMin: SSIM_FLOOR })
    const misaligned = report.samples.filter((s: any) => !s.aligned)
    expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
    expect(lowSsim, JSON.stringify(lowSsim)).toHaveLength(0)
    expect(report.pass).toBe(true)
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 4: Build (E2E flag) + run the gate**

```powershell
cd apps/desktop
$env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build
npx playwright test -c playwright.config.ts e2e/electron/conformance.spec.ts
```
Expected: PASS — the export completes through the bridge (import → place → export → audio mix → mux), `analyze` reports every sample aligned with SSIM ≥ 0.80. If the hook never mounts (`newProjectAndEnter never mounted`), the `VITE_WEFTCUT_E2E` define didn't bake — re-check Step 1 and that the build ran with the env var set.

- [ ] **Step 5: Confirm the non-E2E electron specs still pass under the E2E build**

Run: `npx playwright test -c playwright.config.ts e2e/electron/s2-smoke.spec.ts e2e/electron/s3a-import.spec.ts`
Expected: PASS — the E2E-flagged build is additive (the hook surface is extra; normal paths unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron.vite.config.ts apps/desktop/e2e/electron/helpers/driver.ts apps/desktop/e2e/electron/conformance.spec.ts
git commit -m "migrate(s3b): E2E build flag + Playwright driver helper + H.264 conformance gate"
```

---

## Task 6: Port the eos-tail + overlap export regressions

The two named regressions (spec exit criterion 4). Both reuse the Task 5 driver helper; the assertion logic + `analyze()` calls are copied verbatim from the WebdriverIO sources (`e2e/specs/export/export_eos_tail.e2e.js`, `export_overlap_same_source.e2e.js`). The mechanical port: `newProject`/`driveExport` come from `./helpers/driver`; `browser.execute(...)` → `page.evaluate(...)`; `browser.executeAsync((a,b,done)=>{…done(x)})` → `page.evaluate(async (o)=>{…return x})`.

**Files:**
- Test: `apps/desktop/e2e/electron/export_eos_tail.spec.ts` (create)
- Test: `apps/desktop/e2e/electron/export_overlap_same_source.spec.ts` (create)

**Interfaces:**
- Consumes: Task 5's `launchApp`/`newProject`/`driveExport`; the hooks `importAndPlaceMedia`/`placeMediaLayer`/`waitMediaExportReady`/`exportTimeline`; `window.__weftcutExportPerf`; `analyze()`.

- [ ] **Step 1: Port the eos-tail gate**

Create `apps/desktop/e2e/electron/export_eos_tail.spec.ts`:
```ts
import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps_eostail.mp4')
const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-eostail-out.mp4')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-eostail-proj')

// Final GOP spans chunks + 11s audio overhang vs 10s video — the EOS-tail
// deadlock class. The export must COMPLETE (the deadlock pinned the counter),
// plan 330 frames, and keep the drained tail frame-aligned.
test('EOS-tail export completes and keeps the drained tail frame-aligned (Electron)', async () => {
  test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
  test.setTimeout(220000)
  mkdirSync(PROJECT_PARENT, { recursive: true })
  rmSync(OUTPUT, { force: true })

  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-eostail-' + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    const r = await driveExport(page, { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT })
    if (!r.done.ok) throw new Error('exportClip failed: ' + r.done.error)

    const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
      | { totalFrames: number; totalDispatched: number }
      | null
    if (perf) {
      expect(perf.totalFrames, 'audio-extended 11s composition plans 330 frames').toBe(330)
    }

    // Samples 200 + 270 sit inside the EOS drain region; keep below 300 (the
    // clamp-held overhang frames are last-frame dups by design).
    const SSIM_FLOOR = 0.8
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150, 200, 270], ssimMin: SSIM_FLOOR })
    const misaligned = report.samples.filter((s: any) => !s.aligned)
    expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
    expect(lowSsim, JSON.stringify(lowSsim)).toHaveLength(0)
    expect(report.pass).toBe(true)
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 2: Port the overlap gate**

Create `apps/desktop/e2e/electron/export_overlap_same_source.spec.ts`:
```ts
import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, waitForHook, driveExport } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps.mp4')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-overlap-proj')
const OUT_BASELINE = path.resolve(os.tmpdir(), 'weftcut-e2e-overlap-baseline.mp4')
const OUT_STACKED = path.resolve(os.tmpdir(), 'weftcut-e2e-overlap-stacked.mp4')
const OUT_OFFSET = path.resolve(os.tmpdir(), 'weftcut-e2e-overlap-offset.mp4')
const SSIM_FLOOR = 0.8
const OFFSET_US = 2_000_000
const OFFSET_FRAMES = 60

async function bootProject(page: Page, prefix: string): Promise<void> {
  await newProject(page, {
    parentFolder: PROJECT_PARENT,
    name: prefix + Date.now(),
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
  })
  await waitForHook(page, 'exportTimeline')
}

// Import SOURCE once at t=0, then place `extras` more copies of the SAME
// mediaId (one fresh track each), and wait for export readiness.
async function placeSameSourceClips(page: Page, extras: number[]): Promise<void> {
  const r = (await page.evaluate(
    async ({ media, exs }) => {
      try {
        const first = await (window as any).__weftcutTest.importAndPlaceMedia({ mediaAbsPath: media, tStartUs: 0 })
        for (const tStartUs of exs) {
          await (window as any).__weftcutTest.placeMediaLayer({ mediaId: first.mediaId, tStartUs })
        }
        await (window as any).__weftcutTest.waitMediaExportReady({ mediaId: first.mediaId })
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
    { media: SOURCE, exs: extras },
  )) as { ok: boolean; error?: string }
  if (!r.ok) throw new Error('placing clips failed: ' + r.error)
}

async function runTimelineExport(page: Page, output: string): Promise<{ totalFrames: number; totalDispatched: number }> {
  rmSync(output, { force: true })
  const r = await driveExport(page, { outputAbsPath: output }, { hook: 'exportTimeline' })
  if (!r.done.ok) throw new Error('exportTimeline failed: ' + r.done.error)
  const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
    | { totalFrames: number; totalDispatched: number }
    | null
  if (!perf) throw new Error('export settled but __weftcutExportPerf is missing')
  return perf
}

function assertIdentityAligned(report: any): void {
  const misaligned = report.samples.filter((s: any) => !s.aligned)
  expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
  const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
  expect(lowSsim, JSON.stringify(lowSsim)).toHaveLength(0)
}

test.describe('same-source overlapping clips export (Electron)', () => {
  let baselineDispatched: number | null = null
  test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)

  test.beforeAll(() => {
    mkdirSync(PROJECT_PARENT, { recursive: true })
  })

  test('baseline: a single clip exports clean (dispatch reference)', async () => {
    test.setTimeout(220000)
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-overlap-base-')
      await placeSameSourceClips(page, [])
      const perf = await runTimelineExport(page, OUT_BASELINE)
      expect(perf.totalFrames, '10s @ 30fps = 300 frames').toBe(300)
      baselineDispatched = perf.totalDispatched
      const report = analyze({ output: OUT_BASELINE, source: SOURCE, samples: [30, 150, 290], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(report)
    } finally {
      await app.close()
    }
  })

  test('two stacked enabled clips export without wedging or extra decode', async () => {
    test.setTimeout(220000)
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-overlap-stack-')
      await placeSameSourceClips(page, [0])
      const perf = await runTimelineExport(page, OUT_STACKED)
      expect(perf.totalFrames).toBe(300)
      const report = analyze({ output: OUT_STACKED, source: SOURCE, samples: [30, 150, 290], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(report)
      if (baselineDispatched == null) throw new Error('baseline dispatch reference missing')
      const ceiling = Math.ceil(baselineDispatched * 1.25)
      expect(perf.totalDispatched, `stacked must merge same-source ranges (<= ${ceiling})`).toBeLessThanOrEqual(ceiling)
    } finally {
      await app.close()
    }
  })

  test('a 2s-offset overlap exports complete with both clips on their own frames', async () => {
    test.setTimeout(360000)
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-overlap-offset-')
      await placeSameSourceClips(page, [OFFSET_US])
      const perf = await runTimelineExport(page, OUT_OFFSET)
      expect(perf.totalFrames, '12s composition = 360 frames').toBe(360)
      const headReport = analyze({ output: OUT_OFFSET, source: SOURCE, samples: [30], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(headReport)
      const tail = analyze({ output: OUT_OFFSET, source: SOURCE, samples: [200], window: OFFSET_FRAMES + 2 })
      const s = tail.samples[0]
      expect(s.best_match_index, `output 200 best-matches source ${200 - OFFSET_FRAMES}`).toBe(200 - OFFSET_FRAMES)
    } finally {
      await app.close()
    }
  })
})
```

- [ ] **Step 3: Build (E2E flag) + run both gates**

```powershell
cd apps/desktop
$env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build
npx playwright test -c playwright.config.ts e2e/electron/export_eos_tail.spec.ts
npx playwright test -c playwright.config.ts e2e/electron/export_overlap_same_source.spec.ts
```
Expected: PASS — eos-tail completes at 330 planned frames with the drain region aligned; overlap's baseline/stacked/offset all complete, stacked stays under the 1.25× dispatch ceiling, and the offset clip best-matches at frame 140.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/electron/export_eos_tail.spec.ts apps/desktop/e2e/electron/export_overlap_same_source.spec.ts
git commit -m "migrate(s3b): port eos-tail + overlap export regressions to Playwright-for-Electron"
```

---

## Task 7: Port the AV1 + HEVC + 10-bit codec smoke

Exit criterion 1's non-H.264 coverage: AV1 (WebCodecs sw encode), HEVC (ffmpeg `transcode_and_mux` → `export:transcode_progress`), and 10-bit (WS `videosink` → ffmpeg). Mechanical port of `e2e/specs/export/export_content_modes.e2e.js` + `export_10bit.e2e.js` onto the Task 5 helper — the per-codec `settings` objects and `analyze()` asserts are copied verbatim from those sources (they encode the correct ExportSettings field names + floors).

**Files:**
- Test: `apps/desktop/e2e/electron/export_codecs.spec.ts` (create)

**Interfaces:**
- Consumes: Task 5's `launchApp`/`newProject`/`driveExport`/`waitForHook`; the `exportTimeline`/`importAndPlaceMedia`/`waitMediaExportReady` hooks; `mux_export` (transcode) + the video-sink commands (Task 2/3); `analyze()`.

- [ ] **Step 1: Read the two source specs to recover the exact settings**

Read `apps/desktop/e2e/specs/export/export_content_modes.e2e.js` and `apps/desktop/e2e/specs/export/export_10bit.e2e.js`. Note for each scenario: the fixture used, the `settings` object passed to `exportTimeline`/`exportClip` (codec, bitDepth, hwAccel, rateMode, audio.include, …), the output extension, and the `analyze()` call (samples + floors). These are the authoritative, codec-correct values — copy them verbatim in Step 2.

- [ ] **Step 2: Write the ported codec smoke**

Create `apps/desktop/e2e/electron/export_codecs.spec.ts` using the Task 5 driver helper. Structure (one `test` per codec; copy each `settings`/`analyze` block verbatim from the source spec identified in Step 1):
```ts
import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps.mp4')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-codecs-proj')

// One import+export per codec via exportClip(settings). The `settings` objects
// + the analyze() floor for each case are copied verbatim from
// export_content_modes.e2e.js / export_10bit.e2e.js (Step 1).
async function exportTo(
  page: Page,
  codecLabel: string,
  settings: Record<string, unknown>,
  output: string,
): Promise<void> {
  const r = await driveExport(page, { mediaAbsPath: SOURCE, outputAbsPath: output, settings })
  if (!r.done.ok) throw new Error(`${codecLabel} export failed: ` + r.done.error)
}

test.describe('multi-codec export smoke (Electron)', () => {
  test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
  test.beforeAll(() => mkdirSync(PROJECT_PARENT, { recursive: true }))

  // AV1 (WebCodecs sw encode) — settings + floor verbatim from source spec.
  test('AV1 export produces an aligned file', async () => {
    test.setTimeout(260000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-av1.mp4')
    rmSync(OUTPUT, { force: true })
    const { app, page } = await launchApp()
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'e2e-av1-' + Date.now(), canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
      await exportTo(page, 'AV1', { /* codec:'av1', … — copy from source spec */ }, OUTPUT)
      const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: 0.6 })
      expect(report.samples.filter((s: any) => !s.aligned), JSON.stringify(report.samples)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  // HEVC (ffmpeg transcode_and_mux → export:transcode_progress).
  test('HEVC export produces an aligned file', async () => {
    test.setTimeout(260000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-hevc.mp4')
    rmSync(OUTPUT, { force: true })
    const { app, page } = await launchApp()
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'e2e-hevc-' + Date.now(), canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
      await exportTo(page, 'HEVC', { /* codec:'hevc', … — copy from source spec */ }, OUTPUT)
      const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: 0.6 })
      expect(report.samples.filter((s: any) => !s.aligned), JSON.stringify(report.samples)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  // 10-bit HEVC (WS videosink → ffmpeg). Drives export_video_sink_start/finish.
  test('10-bit export produces an aligned file', async () => {
    test.setTimeout(260000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-10bit.mp4')
    rmSync(OUTPUT, { force: true })
    const { app, page } = await launchApp()
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'e2e-10bit-' + Date.now(), canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
      await exportTo(page, '10-bit', { /* codec:'hevc', bitDepth:10, … — copy from export_10bit.e2e.js */ }, OUTPUT)
      const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: 0.6 })
      expect(report.samples.filter((s: any) => !s.aligned), JSON.stringify(report.samples)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })
})
```
Replace each `{ /* … copy from source spec */ }` with the exact `settings` object from the source spec (Step 1). If a source scenario uses a non-`exportClip` flow (e.g. `importAndPlaceMedia` + `exportTimeline`), mirror that flow with `driveExport(page, …, { hook: 'exportTimeline' })` (as in Task 6's overlap port).

- [ ] **Step 3: Build (E2E flag) + run the smoke**

```powershell
cd apps/desktop
$env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build
npx playwright test -c playwright.config.ts e2e/electron/export_codecs.spec.ts
```
Expected: PASS — each codec produces an aligned output. AV1/HEVC validate `mux_export` (transcode); 10-bit validates the WS `videosink` (start/finish) + HW encoder path end-to-end. (Self-skips without the fixture.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/electron/export_codecs.spec.ts
git commit -m "migrate(s3b): port AV1/HEVC/10-bit codec export smoke to Playwright-for-Electron"
```

---

## Task 8: S3b acceptance notes + housekeeping

**Files:**
- Create: `apps/desktop/electron/S3b-NOTES.md`

- [ ] **Step 1: Run the whole electron e2e suite once (E2E build)**

```powershell
cd apps/desktop
$env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build
npx playwright test -c playwright.config.ts
```
Expected: the S2/S3a specs + the S3b specs (`s3b-fs`, `conformance`, `export_eos_tail`, `export_overlap_same_source`, `export_codecs`) PASS (codec/conformance specs self-skip if `WEFTCUT_TEST_MEDIA` is unset). Note any skips.

- [ ] **Step 2: Full Rust suite once more**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export`
Expected: PASS, 0 failed.

- [ ] **Step 3: Write the acceptance notes**

Create `apps/desktop/electron/S3b-NOTES.md` recording: the `export` feature on (build = `napi:build --features jobs,export`); export+videosink decoupled to EventSink + `Backend.video_sink`/`hw_encoder`; the 6 export dispatch arms wired (audio-only/mux/conform + sink start/finish/cancel); `export_video_sink_write` intentionally unported (WS sole transport, B2); `fs:*` handlers live (append-write for the fMP4 stream); the `VITE_WEFTCUT_E2E` build requirement for the hook surface; the Playwright driver helper + the ported gates (conformance, eos-tail, overlap, codec smoke) green; deferred (drag-drop import → later; ffmpeg bundling → S6; motif/cloud/mcp → S5/S4). Record the exact e2e build + run commands and which specs need `WEFTCUT_TEST_MEDIA`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/S3b-NOTES.md
git commit -m "migrate(s3b): S3b export acceptance notes"
```

---

## Self-Review

**Spec coverage (S3 design `## S3b — Export` + command surface):**
- B1 (export un-gate + EventSink decouple; HW routing unchanged) → Task 1. ✓
- B2 (WS video sink kept; `export_video_sink_write` IPC byte-fallback NOT ported) → Task 1 Step 4 (delete) + Task 3 (start/finish/cancel only; write stays `unavailable`). ✓
- B3 (fMP4 streaming to disk via `fs:writeFile` append + `fs:remove/exists/readDir/readFile/writeTextFile` + shim options forwarding) → Task 4. ✓
- B4 (dispatcher arms for all S3b commands) → Task 2 (audio-only/mux/conform) + Task 3 (sink start/finish/cancel). ✓
- Command surface table: `ensure_export_audio_conform`, `export_project_audio_only`, `mux_export` → Task 2; `export_video_sink_start/finish/cancel` → Task 3; `export_video_sink_write` → intentionally `unavailable` (B2), noted in Task 8. ✓
- Cross-cutting e2e port (D4: media-conformance + export to Playwright-for-Electron) → Task 5 (driver helper + conformance) + Task 6 (eos-tail + overlap) + Task 7 (AV1/HEVC/10-bit). ✓
- S3b exit criteria: (1) valid file H.264/AV1/HEVC/10-bit → Tasks 5+7; (2) `export:transcode_progress` drives UI + file plays → Task 1 (event parity) + Task 7 (HEVC transcode); (3) export Rust unit tests pass → Task 1 Step 7; (4) Playwright export gate incl. eos-tail + overlap → Tasks 5+6. ✓

**Placeholder scan:** Tasks 1–6 carry full code (decouple edits with exact before/after, command bodies, dispatch arms, handlers, helper, three full ported specs). Task 7's per-codec `settings` objects are explicitly deferred to a read-the-source-spec step (Step 1) because the codec-correct ExportSettings field values live verbatim in `export_content_modes.e2e.js`/`export_10bit.e2e.js` — copying them is mechanical and compiler/floor-enforced, not open-ended; the spec skeleton, flow, and asserts are concrete.

**Type consistency:** `&Arc<dyn EventSink>` first param of `transcode_and_mux` consistent between Task 1 (def) and Task 2 (caller `&backend.events`); `export_audio_only(&Project, …)` (no `_app`) consistent between Task 1 (def) and Task 2 (caller); `VideoSinkState`/`HwEncoderCache` `Backend` fields consistent between Task 1 (def/construct) and Task 3 (callers `&self.video_sink`/`&self.hw_encoder`); `VideoSinkStartArgs`/`VideoSinkStartReply`/`SinkStats` reused from `videosink.rs` (unchanged) in Task 3; arg structs `ExportAudioOnlyArgs { output_path, audio, start_us, end_us }` (camelCase `outputPath`/`startUs`/`endUs`) match the renderer `muxExport`/`exportProjectAudioOnly` payloads; `driver.ts` `launchApp`/`newProject`/`driveExport`/`waitForHook`/`MAIN` signatures consistent across Tasks 5/6/7 consumers; `analyze()` (from `e2e/lib/analyze.mjs`) call shape (`{output, source, samples, ssimMin, window}`) matches the WebdriverIO source specs verbatim.
