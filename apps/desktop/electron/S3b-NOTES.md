# S3b Export Acceptance Notes

## Build Requirement

The napi addon must be built with `--features jobs,export`:

```
napi:build --features jobs,export
```

Without the `export` feature flag the 6 S3b export commands return
`"unavailable: ... S3/S4/S5"` and the fMP4 append-write path is not
compiled in.

The Playwright e2e gates additionally require the renderer to be built with
the `VITE_WEFTCUT_E2E` environment variable set to `'1'`. This flag inlines
the `e2eHook.ts` entry-point that installs `window.__weftcutTest` and
`window.__weftcutExportPerf`. Without it all export specs will fail at the
hook-surface call.

Full E2E build sequence (PowerShell):

```powershell
cd apps/desktop
$env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build
```

## Tests

**`cargo test --lib --features jobs,export`:** 451 passed; 0 failed.
Finished in 13.79 s.

Tests added in S3b include:

- Unit tests from Task 1 covering the `export` module's EventSink-decoupled
  paths (event emission and videosink state machine).

**Playwright suite (`npx playwright test -c playwright.config.ts`):**
14 tests, 14 passed, 0 failed, 5.1 min total.
All 10 specs (S2 + S3a + S3b) ran against the full E2E build.

| Spec | Tests | Result | Notes |
|---|---|---|---|
| `s2-smoke.spec.ts` | 1 | PASS | napi bridge round-trip |
| `s3a-handlers.spec.ts` | 1 | PASS | `path:join` / `path:tempDir` |
| `s3a-import.spec.ts` | 1 | PASS | PNG import → `Ready` state |
| `s3a-protocol.spec.ts` | 1 | PASS | `weftcut-media://` Range 206 |
| `s3a-window-visible.spec.ts` | 1 | PASS | `isVisible()===true` |
| `s3b-fs.spec.ts` | 1 | PASS | `fs:writeFile` append vs truncate |
| `conformance.spec.ts` | 1 | PASS | H.264 import→export SSIM 0.877–0.905 (floor 0.80); all 3 sample frames aligned |
| `export_eos_tail.spec.ts` | 1 | PASS | 330 frames planned and drained; samples 200+270 aligned; all SSIM ≥ 0.80 |
| `export_overlap_same_source.spec.ts` | 3 | PASS | baseline 300 frames; stacked 300 frames ≤ 1.25× dispatch ceiling; 2 s-offset 360 frames, tail best-matches frame 140 |
| `export_codecs.spec.ts` | 3 | PASS | AV1: codec_name=av1, SSIM 0.877–0.888 (floor 0.6), all frames aligned; HEVC: codec_name=hevc, pix_fmt=yuv420p (8-bit), all frames aligned (SSIM ~0.51 — low but gate is on alignment not SSIM floor for HEVC); 10-bit HEVC: codec_name=hevc, pix_fmt=yuv420p10le, profile=Main 10, color_space/transfer/primaries=bt709, SSIM 0.928 ≥ 0.60 |

Specs that need `WEFTCUT_TEST_MEDIA`: `conformance`, `export_eos_tail`,
`export_overlap_same_source`, `export_codecs`. These look for fixtures under
`e2e/fixtures/media/` by default (populated in the repo); set
`WEFTCUT_TEST_MEDIA` to a custom directory to override. They self-skip if the
source file is absent.

## What Was Done in S3b

### B1 — `export` feature enabled; EventSink + Backend stores

`Cargo.toml` `[features]`: `export` is NOT in the default feature set; enabled
explicitly via `napi:build --features jobs,export`.

`export/mod.rs` and `export/videosink.rs` were decoupled from
`tauri::AppHandle`. Export progress events (`export:progress`,
`export:transcode_progress`, `export:done`, `export:error`) and the
`VideoSinkState` lifecycle are now emitted through `Arc<dyn EventSink>` — the
same napi TSFN bridge as all other backend events.

`Backend` gained two new fields:

- `video_sink: Arc<Mutex<VideoSinkState>>` — serialises
  `export_video_sink_start/finish/cancel` access.
- `hw_encoder: Arc<Mutex<HwEncoderCache>>` — caches hardware-encoder probes
  across exports (unchanged routing; NVENC/QSV/VideoToolbox detection is
  platform-specific, not Tauri-specific).

### B2 — `export_video_sink_write` intentionally unported

The WebSocket videosink (`VideoSinkState::WsWriter`) is the sole video-frame
transport for both 8-bit (WebCodecs canvas) and 10-bit (f16/WebGL2) paths. It
opens a loopback `ws://localhost:NNNNN` connection from the renderer → main
process, bypassing IPC entirely. There is no IPC byte-fallback path, and
`export_video_sink_write` was deleted in Task 1 Step 4.

The WS server bind and the `start`/`finish`/`cancel` lifecycle arms are fully
ported (B4). The write arm is unported by design (B2 scope note).

### B3 — `fs:*` handlers + fMP4 append-write

`electron/main/index.ts` handles the `fs:` IPC channel:

- `writeFile` — supports both truncate (default) and append mode; the append
  path is the fMP4 streaming sink (renderer calls `writeFile(path, chunk,
  {append:true})` for every muxed segment).
- `remove`, `exists`, `readDir`, `readFile`, `writeTextFile` — file-system
  utilities consumed by the export preparation path and project I/O.
- Plugin-fs options forwarding — the renderer's `@tauri-apps/plugin-fs` shim
  maps Tauri option structs to the Electron channel call; the main-process
  handler normalises both the legacy positional form and the options-object form
  for backward compatibility.

### B4 — 6 export dispatch arms wired

| Command | Route |
|---|---|
| `ensure_export_audio_conform` | audio conformance pre-check |
| `export_project_audio_only` | audio-only export (no video sink) |
| `mux_export` | mux a WebCodecs-encoded mezzanine into the output container |
| `export_video_sink_start` | open the loopback WS server; return port + key |
| `export_video_sink_finish` | drain + close; return `SinkStats` |
| `export_video_sink_cancel` | abort the active sink session |

The `transcode_and_mux` path (HEVC/AV1 transcodes) is invoked by `mux_export`
and emits `export:transcode_progress` through the EventSink bridge.

### D4 — Playwright driver helper + ported e2e gates

`e2e/electron/helpers/driver.ts` provides:

- `launchApp()` — launches `out/main/index.js` via `_electron.launch`; waits
  for the renderer.
- `newProject(page, opts)` — creates a named project at a temp path with the
  requested canvas/fps.
- `driveExport(page, args, opts?)` — calls either `exportClip` or
  `exportTimeline` via `window.__weftcutTest`, waits for `export:done` or
  `export:error`, returns the settled result.
- `waitForHook(page, name)` — polls until `window.__weftcutTest[name]` is
  available (guards against hook-surface race on cold launch).
- `MAIN` — resolved path to `out/main/index.js`.

Ported export regression gates:

- **H.264 conformance** (`conformance.spec.ts`): import → export → analyze;
  SSIM floor 0.80 at frames 30/150/270; strict alignment.
- **EOS-tail** (`export_eos_tail.spec.ts`): 11 s audio / 10 s video source;
  330 planned frames; drain-region samples aligned.
- **Overlap × 3** (`export_overlap_same_source.spec.ts`): baseline single clip,
  two stacked same-source clips (≤ 1.25× dispatch ceiling), 2 s-offset overlap.
- **Codec smoke × 3** (`export_codecs.spec.ts`): AV1 (WebCodecs sw encode);
  HEVC 8-bit (ffmpeg transcode); 10-bit HEVC (WS videosink, HEVC Main10).

### S3a Defect Fix (folded into Task 5)

`path:join` in `electron/main/index.ts` was calling
`path.join(...args.parts)` where the IPC payload field is `paths`, not
`parts`. This caused `path:join` to silently return an empty string for
multi-component joins. Fixed to `path.join(...args.paths)`.

## Deferred

- **Drag-drop import** — blocked on the `postMessageWithAdditionalObjects`
  Windows platform shim; deferred to later polish.
- **ffmpeg binary bundling** — production signing + sidecar packaging for
  distribution; S6.
- **Motif capture / cloud transcription / MCP bridge** — S5/S4.
- **Manual interactive export verification** — the Playwright gates cover the
  automated path; a manual scrub-and-export session in the built app confirms
  the full UI flow (export settings dialog, progress bar, output playback).

## Acceptance (2026-06-18)

- Rust suite: 451 passed, 0 failed (`--features jobs,export`).
- Playwright suite: 14/14 passed (full E2E build, all S2 + S3a + S3b specs).
- H.264 conformance SSIM 0.877–0.905 at frames 30/150/270 (floor 0.80).
- EOS-tail 330 frames drained; drain-region aligned.
- Overlap baseline 300 fr, stacked 300 fr within dispatch ceiling, offset 360 fr tail best-match correct.
- AV1 codec_name=av1, SSIM 0.877–0.888 (floor 0.6), aligned.
- HEVC codec_name=hevc pix_fmt=yuv420p (8-bit), aligned (SSIM ~0.51; gate is alignment-only for HEVC).
- 10-bit HEVC codec_name=hevc pix_fmt=yuv420p10le profile="Main 10" SSIM 0.928.
