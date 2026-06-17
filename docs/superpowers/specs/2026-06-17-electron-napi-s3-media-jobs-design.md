# S3 — Media + Jobs (Electron + napi-rs migration) — design

> Stage S3 of the Tauri → Electron + napi-rs migration. Branch `migration/electron-napi`.
> Predecessor: S2 (napi state core + event bridge) COMPLETE at `127249c3`. Master plan:
> `docs/superpowers/plans/2026-06-17-electron-napi-migration.md`. This spec is the just-in-time
> S3 design; it produces two implementation plans (S3a, S3b).

## Goal

Move the media + jobs subsystems from the Tauri shell onto the napi-rs `Backend`, so that under
Electron a user can **import media → generate proxies/thumbnails/waveform/conform → scrub-preview
decoded frames → export an end-to-end video file**, with the existing Rust domain code ported
near-verbatim and the renderer unchanged behind the S1/S2 compat shims.

S3 is the largest stage, so it is split into two independently shippable sub-stages:

- **S3a — Ingest + Preview**: media serving, ffmpeg bootstrap, the import/jobs pipeline, import
  entry points. Exit: import (file picker) → derivatives generate (live job events) → scrub
  preview plays.
- **S3b — Export**: the export pipeline, the loopback WebSocket video sink, transcode/mux, the
  fMP4-to-disk writer. Exit: end-to-end export (H.264 + AV1 + HEVC transcode + 10-bit via WS).

S3a delivers a preview-capable app on its own; S3b consumes S3a's conform/proxy output.

## Decisions (resolved in brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | S3 sequencing | **Split S3a / S3b** (two specs-of-record share this design; two impl plans) |
| D2 | 10-bit export transport | **Keep the loopback WebSocket** (`tungstenite`, `127.0.0.1:0`); no rewrite to IPC |
| D3 | ffmpeg shipping | **Keep ffmpeg-sidecar auto-download** in S3; bundle via electron-builder `extraResources` at S6 |
| D4 | e2e port scope | **Media-conformance + import + export** ported to Playwright-for-Electron; motif/UI specs stay on their stages |
| D5 | Drag-drop import | **Deferred** — S3 ships **picker-only** import; drag-drop restored in a later polish stage |

## Current state (verified during recon)

- **Feature gates** (`apps/desktop/src-tauri/Cargo.toml`): `default = []`. `jobs` and `export` are
  OFF; `audio`, `ffmpeg`, `io::probe` are gated behind `any(feature="jobs", feature="export")`.
  `cloud`/`mcp`/`motifs`/`media_drop`/`sysmon` are separate gates left OFF for S3.
- **Dispatcher** (`napi_backend.rs:202` `Backend::dispatch(cmd, args) -> Result<String,String>`):
  a `match cmd` over the S2 command set (lines 204–381) with `other => Err("unavailable: … later
  stage (S3/S4/S5)")` at line 382. Every S3 command currently falls through to that arm.
- **EventSink** (`src/events.rs`): `trait EventSink { fn emit(&self, event: &str, payload: Value) }`.
  Production `TsfnEventSink` wraps one `ThreadsafeFunction<String>` and ships `{event, payload}`
  JSON to JS; test `VecEventSink` records `(name, payload)`. `Backend` already holds
  `events: Arc<dyn EventSink>`.
- **Jobs** (`src/jobs/`): `mod.rs` (dispatch + events), `import.rs`, `proxy.rs`, `quick_proxy.rs`,
  `proxy_decision.rs`, `conform.rs`, `thumbnails.rs`, `waveform.rs`, `hwaccel.rs`, `frame.rs`.
  `enqueue_for_media` fans out jobs by media kind under a 2-permit ffmpeg semaphore. Job events
  (`media:job_started` / `media:job_complete` / `media:job_error`) are emitted via a private
  `fn emit(app: &AppHandle, …)` helper using `app.emit()`. Completion patches the `MediaItem`
  through the actor → `project:changed`.
- **Export** (`src/export/`): `mod.rs` (audio encode + `transcode_and_mux`), `videosink.rs`
  (tungstenite loopback sink: binds `127.0.0.1:0`, UUID text-token handshake, binary frames →
  ffmpeg stdin), `hwencoder.rs` (HW encoder cache + codec routing). `transcode_and_mux` emits
  `export:transcode_progress` via `app.emit()`.
- **ffmpeg** = `ffmpeg-sidecar = "2"` (spawns a binary; auto-downloads to its cache on first run).
  NOT a linked lib. `[profile.dev] opt-level=1` is already set so the dev/e2e WS read loop sustains
  ~340 MB/s (the 10-bit transport fix).
- **Media serving today**: Tauri's built-in `asset://` (wry). The renderer fetches media URLs
  produced by `convertFileSrc(path)` (currently the S1 stub in `electron-compat/tauri-core.ts`,
  returns the path unchanged). The mediabunny adapter `AssetRangeSource`
  (`src/render/decoder/AssetRangeSource.ts`) issues HTTP `Range` reads and already loops on short
  reads (it was written around the WebView2 ~1 MB 206 cap), expecting `206` + `Content-Range`.
- **Import entry points** (`App.tsx`): the file picker (`openDialog` → `dialog:open`) and the
  media-pool drag-drop (`MediaDropZone.onDrop` at `App.tsx:2378`), which calls the raw WebView2
  `window.chrome.webview.postMessageWithAdditionalObjects(...)` — undefined under Electron. Both
  funnel into `importPaths(paths)` → `import_media`. `media_drop.rs` (the WebView2-COM path
  recovery) has no Electron equivalent.
- **plugin-fs shim** (`electron-compat/plugin-fs.ts`): the renderer imports `writeFile`/`remove`
  (App.tsx) and `exists`/`readDir` (e2eHook); each invokes `fs:<name>`. The shim currently drops
  the options arg.

## Architecture

The seam established in S2 is unchanged: **renderer → preload (`window.api`) → main (`backend:invoke`
+ direct `window:*`/`path:*`/`dialog:*`/`fs:*` handlers) → napi `Backend`**. S3 widens it on three
fronts: more dispatcher arms (media + export commands), more main-process handlers (media protocol,
dialog, fs-append, path, resize forwarder), and the EventSink decoupling inside jobs/export.

### Shared foundation (lands in S3a; both sub-stages depend on it)

**F1 — Flip the feature gates.** S3a enables **`jobs`** in the addon build, which transitively
pulls `audio`, `ffmpeg`, `io::probe` (all gated `any(jobs,export)`). `export` is enabled in S3b
(B1), so S3a's decouple work (F2) touches only `jobs` + `audio`; export's decouple is B1. This is
the addon build's feature set, not a source edit to call sites. Enabling `jobs` re-introduces the
jobs/audio **Rust unit tests** (currently not compiled) into the build; they must pass.
`cloud`/`mcp`/`motifs` stay OFF.

**F2 — EventSink decoupling.** (Applied to `jobs` in S3a per F1; to `export` in S3b per B1.)
Replace every `app.emit(name, payload)` in `jobs/mod.rs` (and later `export/mod.rs`) with
`sink.emit(name, serde_json::to_value(payload)?)`, where `sink:
Arc<dyn EventSink>` is threaded down from `Backend.events`. Job/export entry functions change their
first parameter from `&AppHandle` (or `AppHandle`) to `Arc<dyn EventSink>` (or `&dyn EventSink`).
**Event names are unchanged** (`media:job_*`, `export:transcode_progress`), so the renderer's
listeners and the `evt:<name>` bridge work untouched — this is the parity guarantee for the bridge.

**F3 — ffmpeg bootstrap.** Call `ffmpeg::bootstrap()` (ffmpeg-sidecar resolve/auto-download) lazily
on first media job. Keep auto-download for S3; binary bundling is S6. Bootstrap failure surfaces as
a `media:job_error` (no crash).

### S3a — Ingest + Preview

**A1 — Media protocol `weftcut-media://`** (replaces `asset://`):
- Register a **privileged scheme** before `app.ready`:
  `protocol.registerSchemesAsPrivileged([{ scheme: 'weftcut-media', privileges: { standard: true,
  secure: true, supportFetchAPI: true, stream: true } }])`.
- `protocol.handle('weftcut-media', handler)` in main:
  - Decode the absolute path from the URL.
  - Read the request's `Range` header. With a range → `206` with `Content-Range: bytes a-b/total`,
    `Accept-Ranges: bytes`, `Content-Length`, body = `fs.createReadStream(path, {start, end})`
    bridged to a web `ReadableStream`. Without a range → `200`, full stream, `Content-Length`,
    `Accept-Ranges: bytes`.
  - **No artificial body cap** — this lifts the WebView2 ~1 MB 206 ceiling. `AssetRangeSource`'s
    short-read loop still works (it fills in one pass).
  - **Path safety**: serve only files under an allow-list of roots (the open workspace's media +
    cache directories, supplied by `Backend`); reject traversal/out-of-root with `403`, missing
    with `404`, unsatisfiable range with `416`.
- `convertFileSrc(path)` (in `electron-compat/tauri-core.ts`, an allowed compat-layer edit) returns
  `weftcut-media://localhost/<encodeURIComponent(absPath)>`. No `src/**` app edits.

**A2 — Jobs wired.**
- Un-gate (F1) and decouple events (F2).
- Re-wire `jobs::enqueue_for_media` at the two sites where S2 dropped it: inside
  `commands::persistence::project_open` (documented inline as a mandatory S3 re-wire) and inside the
  new `import_media` command.
- Add dispatcher arms for the S3a commands (table below). Each wraps the existing `jobs::*` /
  `io::probe` function, passing `Backend.events` as the sink and the actor handle / cache as today.
- Completion path is unchanged: jobs patch the `MediaItem` via the actor → `project:changed` →
  `project_summary` (which already serializes `proxy_path` / `quick_proxy_path` / `conform_path` /
  `proxy_bypassed` / `export_uses_original`) → the UI shows derivative state. No renderer change.

**A3 — Import entry points + S2 carry-overs (main-process handlers).**
- `dialog:open` / `dialog:save` → Electron `dialog.showOpenDialog` / `showSaveDialog`, mapping the
  Tauri opts (`title`, `multiple`, `filters: [{name, extensions}]`, `defaultPath`) to Electron's
  shape; return absolute path(s) (or `null` on cancel) in the Tauri-compatible form the shims expect.
- `path:join` / `path:tempDir` → Node `path.join` / the app cache-or-temp dir (the S2 carry-over:
  these were routed direct but had no handler, so callers got `undefined` and fell back).
- `onResized` forwarder → main subscribes to the `BrowserWindow` `resize` / `maximize` /
  `unmaximize` events and `webContents.send`s a `window:resized` (or the event name the
  `tauri-window` shim listens for) so the maximize glyph tracks Win+Arrow tiling.
- Housekeeping (cheap, fold in here): add the deferred S2 `log:entry` EventSink test; gate the
  `history.rs` `use chrono::Utc` import so release builds don't warn.

**A4 — Preview.** With protocol-served media + generated proxies, the existing WebCodecs preview
path (`SourceDecoderPool`, `AssetRangeSource`, `PixiPreview`) runs unchanged on Chromium. No new
preview code; S3a's job is to feed it real media URLs + real derivatives.

**S3a exit criteria:**
1. Pick a file via the import dialog → `import_media` runs → proxy_decision fans out
   proxy/quick-proxy/thumbnails/waveform/conform; `media:job_*` events appear live in the UI.
2. The media-pool shows derivative state; scrub-preview decodes and renders frames from the
   protocol-served proxy/original.
3. Re-enabled jobs/audio Rust unit tests pass on the addon build.
4. Playwright-for-Electron **import + preview** gate passes (import a fixture → job events →
   derivative paths populated in `project_summary`). Full media-conformance (export-output
   comparison) is an S3b gate, since it needs export.

### S3b — Export

**B1 — Export un-gate + EventSink decouple.** `transcode_and_mux` emits `export:transcode_progress`
via the sink. HW encoder routing (`hwencoder.rs`) is unchanged.

**B2 — WebSocket video sink (kept).** `videosink.rs` keeps binding `127.0.0.1:0` via tungstenite;
`export_video_sink_start` returns the chosen port; the renderer's `runExport.ts` connects
`ws://127.0.0.1:<port>` and streams `yuv420p10le` frames (UUID handshake, then binary). Identical
WebSocket API under Chromium → no transport rewrite. The `[profile.dev] opt-level=1` fix is already
in `Cargo.toml`.
- The legacy `export_video_sink_write` IPC byte-fallback does **not** fit the JSON-string dispatcher
  (raw frame bytes). Decision: **WS is the sole production transport for S3b.** The IPC byte-write
  is ported only if the WS path proves insufficient under Electron, and then via a dedicated
  `Buffer`-typed napi method outside `dispatch` — not the JSON arm.

**B3 — fMP4 streaming to disk.** The renderer streams the muxed fMP4 via `plugin-fs`
`writeFile(path, bytes, { append: true })`. Add an `fs:writeFile` main handler that honors an
`append` flag (append when set, else truncate-write), and update the `plugin-fs` `writeFile` shim to
forward its options. (`fs:allow-open`-style FileHandle was never granted; append-write is the
established path.) Add the other renderer-used fs handlers actually invoked by the export/import
paths: `fs:remove`, `fs:exists`, `fs:readDir`, `fs:readFile`, `fs:writeTextFile`.

**B4 — Dispatcher arms** for the S3b commands (table below), wrapping `export::*`.

**S3b exit criteria:**
1. End-to-end export produces a valid file for H.264 and AV1 (WebCodecs encode), HEVC (ffmpeg
   transcode), and 10-bit (WS sink → ffmpeg).
2. `export:transcode_progress` drives the UI progress; export completes and the file plays.
3. Re-enabled export Rust unit tests pass.
4. Playwright-for-Electron **export** gate passes (incl. the eos-tail and overlap regressions).

### Cross-cutting — e2e port to Playwright-for-Electron

S2 stood up the Playwright-for-Electron harness (`_electron.launch('out/main/index.js')`, ESM
`__dirname` polyfill). S3 extends it:
- **S3a**: a new **import + preview** spec (import a fixture → poll `project_summary` until job
  events populate derivative paths). This is the S3a gate.
- **S3b**: port the **export** specs (incl. eos-tail + overlap) AND the **media-conformance** specs
  — the Rust analyzer (video frame-align + audio Goertzel) runs unchanged against
  `WEFTCUT_TEST_MEDIA` fixtures; only the driver wrapper (tauri-driver + WebdriverIO + msedgedriver
  → Playwright `_electron`) and the app-launch/selector layer change. Media-conformance is an S3b
  gate because it compares export output to source.
- The `window.__weftcutTest` `e2eHook` injection surface is preserved (already compiled behind
  `VITE_WEFTCUT_E2E=1`).
- Motif and UI specs stay on S5 / their own passes.
- Parity is **perceptual** (different engines), enforced by the conformance analyzer's frame-align
  + audio checks, not byte-identity.

## Command surface (new S3 dispatcher arms)

Every command below currently hits the `unavailable` arm. Arg keys are camelCase per the S2
`#[serde(rename_all="camelCase")]` `*Args` convention, cross-checked against
`apps/desktop/src/ipc/index.ts`.

### S3a (ingest + preview)

| Command | Args | Returns | Wraps |
|---|---|---|---|
| `import_media` | `{ path }` | `string` (media id) | `jobs::import` + `enqueue_for_media` |
| `import_cancel` | `{ mediaId }` | `boolean` | jobs cancel |
| `import_queue_list` | — | `ImportEntry[]` | jobs queue snapshot |
| `get_media_thumbnail` | `{ mediaId }` | `string` | `jobs::thumbnails` |
| `get_waveform_peaks` | `{ mediaId }` | `WaveformPeaks` | `jobs::waveform` |
| `ensure_full_proxy` | `{ mediaId }` | `void` | `jobs::proxy` (route-correcting) |
| `ensure_conform` | `{ mediaId }` | `void` | `jobs::conform` (preview audio) |
| `report_audio_meter` | `{ report }` | `void` | stores an `AudioMeterReport` snapshot |

`report_audio_meter` is pushed by the renderer during playback (`ipc/index.ts:1150`). The Tauri
version held the snapshot in a managed `AudioMeterState` (`Arc<Mutex<Option<(Instant,
AudioMeterReport)>>>`); under napi this becomes a small field on `Backend`. Its only consumers are
the dev PerfHUD / a future MCP tool, so the arm + field land in S3a (audio comes on with `jobs`)
even though no S3 reader exists yet — the renderer call must not hit `unavailable`.

### S3b (export)

| Command | Args | Returns | Wraps |
|---|---|---|---|
| `ensure_export_audio_conform` | `{ … }` | `string[]` | `jobs::conform` (export audio) |
| `export_project_audio_only` | `{ … }` | `boolean` | `export::export_audio_only` |
| `mux_export` | `{ … }` | `void` | `export::transcode_and_mux` |
| `export_video_sink_start` | `{ args }` | sink-start reply (incl. `port`) | `export::videosink` start |
| `export_video_sink_finish` | — | `void` | videosink finish (await ffmpeg exit) |
| `export_video_sink_cancel` | — | `void` | videosink cancel (kill ffmpeg) |
| `export_video_sink_write` | bytes | `void` | videosink IPC fallback (see B2 — WS is primary) |

Exact arg structs for the multi-field commands (`export_project_audio_only`, `mux_export`,
`ensure_export_audio_conform`, `export_video_sink_start`) are recovered verbatim from
`4a0dda90:apps/desktop/src-tauri/src/commands.rs` and reconciled field-for-field against
`ipc/index.ts` during planning.

`import_motif` is S5 (motif), not S3.

## Error handling

- ffmpeg unavailable / bootstrap failure → `media:job_error` → existing UI error state.
- `protocol.handle` → `403` (out-of-root / traversal), `404` (missing), `416` (unsatisfiable range).
- Job failure → `media:job_error` with the failing kind; the actor is not patched; UI keeps the
  pre-job derivative state.
- WS sink connection drop → export surfaces an error to the renderer orchestrator (existing
  behavior); WS is the production path.

## Testing & parity oracle

- **Rust unit tests** in `jobs` / `export` / `audio` (compiled once F1 flips the gates) must pass —
  the bulk of the ~300+ tests not currently built.
- **Playwright-for-Electron gates**: S3a = import + preview; S3b = export + media-conformance.
- **Parity** = the conformance analyzer's perceptual frame-align + audio-Goertzel checks on
  `WEFTCUT_TEST_MEDIA` fixtures, plus import-derivative correctness.

## Deferred out of S3 (explicit)

- **Drag-drop import** — picker-only in S3 (D5); `media_drop.rs` / `webUtils.getPathForFile`
  restoration is a later polish stage.
- **ffmpeg binary bundling** — `extraResources` + per-platform binaries land at S6 (D3).
- **S4-start prerequisite** (carried, not S3): widen the `audio` gate to include `mcp`
  (`mcp/mod.rs` uses `audio::mix`).

## Out of scope

Renderer business logic (`src/**` app code) is not edited; the only renderer-side change is the
`convertFileSrc` body and the `plugin-fs` options-forwarding inside the `electron-compat/` shim
layer, both already part of the sanctioned compat surface. No motif/cloud/mcp work.
