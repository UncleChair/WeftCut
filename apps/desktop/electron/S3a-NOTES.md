# S3a Media / Jobs Acceptance Notes

## Build Requirement

The napi addon must be built with `--features jobs`:

```
napi:build --features jobs
```

Without this flag the 8 S3a media commands return `"unavailable: ... S3/S4/S5"` and
the `weftcut-media://` protocol is not registered.

## Tests

**`cargo test --lib --features jobs`:** 435 passed; 0 failed.

Tests added in S3a include:

- `import_media_adds_to_pool_and_returns_id` — imports a 1×1 PNG (image path, no
  ffmpeg job), asserts a media ID is returned and appears in `project_summary`.
- `get_waveform_peaks_unknown_media_errors` — confirms `get_waveform_peaks` for an
  unknown ID returns an error containing "not found".
- `report_audio_meter_stores_snapshot` — confirms `report_audio_meter` accepts a
  `{rmsDb, peakDb}` report and returns null.
- `logged_action_after_workspace_emits_log_entry` (S2 deferred cleanup) — installs
  a workspace via `project_save_as`, dispatches `log_emit`, and polls until
  `log:entry` appears in the `VecEventSink`; verifies the async LogBus broadcast
  bridge reaches the sink end-to-end.

**Playwright S3a gate (`s3a-import.spec.ts`):** import gate green — launches the
built Electron app, imports a real video file, polls `import_queue_list` until the
item transitions to `Ready`, and asserts the returned media ID is non-empty.

**Playwright protocol + handler specs:** `weftcut-media://` Range + CORS spec and
dialog/path handler spec both pass.

## What Was Done in S3a

### F1 — `jobs` feature enabled

`Cargo.toml` `[features]` default now includes `jobs`; the napi
`build_backend` assembles `ImportQueue::new(events, log_slot)` when the
feature is active.

### F2 — Jobs + import decoupled to EventSink / LogBusSlot

`ImportQueue::new` takes `Arc<dyn EventSink>` + `LogBusSlot`. No
`tauri::AppHandle` dependency. Events (`media:import:progress`,
`media:import:ready`, `media:import:error`) reach the Electron renderer through
the same napi TSFN bridge as all other backend events.

### F3 — ffmpeg bootstrap

`Backend::init` spawns a `ffmpeg::bootstrap()` task off the critical path.
The sidecar binary is resolved (or downloaded) once on first launch so subsequent
media jobs don't pay the latency. Dev and release builds use `ffmpeg-sidecar`.

### A1 — `weftcut-media://` protocol live (Range + CORS)

Registered in `apps/desktop/electron/main/index.ts`. Handles `GET` and `HEAD`
requests for files under the app's cache dir. Supports `Range` requests
(returns 206 Partial Content) for progressive decode. Sets `Access-Control-Allow-Origin: *`
so the webview WebCodecs decoder can fetch proxy files cross-origin.

### A2 — 8 media commands wired in dispatch

| Command | Task |
|---|---|
| `import_media` | enqueue file into `ImportQueue`; return `MediaId` |
| `import_cancel` | cancel a pending/running import job |
| `import_queue_list` | snapshot of all `ImportItem` states |
| `get_media_thumbnail` | extract or return cached thumbnail frame |
| `get_waveform_peaks` | return cached waveform peak data |
| `ensure_full_proxy` | enqueue full-res proxy transcode if not cached |
| `ensure_conform` | enqueue audio-conform job if needed |
| `report_audio_meter` | store a `{rmsDb, peakDb}` meter snapshot |

### A3 — dialog / path handlers + resize forwarder

`dialog:` channel: `showOpenDialog` / `showSaveDialog` / `showMessageBox`
forwarded to Electron's `dialog` module (main process).

`path:` channel: `join` / `tempDir` / `appDataDir` / `appCacheDir` /
`basename` / `dirname` / `extname` resolved in main; previously returned
`undefined` (S2 deviation).

`window:onResized` IPC: forwards Electron `BrowserWindow` resize events to the
renderer so `WindowControls.tsx`'s maximize glyph tracks native window state.

### A4 — Preview verified (import gate green)

`s3a-import.spec.ts` exercises the end-to-end import path in the built Electron
app (Playwright-for-Electron). Manual interactive verification (import a video,
scrub the timeline, confirm Pixi frames render from the `weftcut-media://` proxy)
is still owed — see Deferred below.

### S2 Deferred Cleanups (folded into Task 7)

- `#[cfg(debug_assertions)] use chrono::Utc;` in `commands/history.rs` — the
  import was previously ungated, producing an unused-import warning in release
  builds. Now gated to match its only use site (`debug_simulate_agent_session`).
- `logged_action_after_workspace_emits_log_entry` test in `napi_backend.rs` —
  the deferred EventSink path for `log:entry`. Confirms the full
  `log_emit` → `LogBus::emit` → broadcast bridge → `VecEventSink` chain works
  after a workspace is installed.

## Deferred

- **Manual preview verification** (interactive) — import a video, scrub the
  timeline, confirm Pixi frames render from the `weftcut-media://` proxy.
  Reference screenshot: `s3a-preview.png` (to be captured). This is the only S3a
  exit criterion not yet verified automatically.
- **Drag-drop import** — blocked on the `postMessageWithAdditionalObjects` Windows
  platform shim; deferred to later polish.
- **Export (video encode / WebSocket videosink)** — S3b.
- **ffmpeg bundling** — production signing + sidecar packaging for distribution;
  S6.
- **`fs:*` handlers** — file-system read/write from the renderer; S3b per the spec.
