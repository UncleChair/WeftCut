# Conformance

The conformance suite verifies that the real app export path preserves frame
alignment, audio sync, and color behavior. It is separate from the colocated
renderer unit tests under `apps/desktop/src/render/**` and the tiny demux fixtures
in `apps/desktop/fixtures/media`: these tests drive WebView2, import real
media, export through the Pixi/WebCodecs + Rust ffmpeg pipeline, and analyze
the resulting file.

## Layout

```text
apps/desktop/e2e/
  wdio.conf.mjs                # WebdriverIO + tauri-driver harness
  fixtures/
    generate.go                 # deterministic media fixture producer
    generate-fixtures.mjs        # orchestrator used by E2E prepare
    color_baseline.json          # expected color error for limited-range encodings
    gradient_baseline.json       # expected error for the 10-bit gradient fixture
    media/                       # generated clips; can be overridden
      color_manifest.json        # patch layout for color-conformance (generated)
      .gitkeep
  scripts/run-suite.mjs          # Windows-safe per-suite runner (node -> wdio --suite)
  helpers/                       # shared spec helpers wrapping the wdio `browser`
    app.mjs                      # waitForHook / invokeCmd / newProject / summary / findLayer
    preview.mjs                  # seekUs / sampleAt / waitPreviewBridge
    export.mjs                   # driveExport (fire-and-forget + settle poll, per-hook)
    media.mjs                    # MEDIA_DIR + fixture/tmp path helpers
  specs/                         # grouped into selectable suites (see Running)
    smoke/
      launch.e2e.js              # boots as real WebView2 with the Tauri bridge
    ui/
      layers.e2e.js              # add color/text layer + still-image/gif support
      keyframe_authoring.e2e.js  # keyframe opacity ramp -> export
    export/
      conformance.e2e.js         # video frame alignment + SSIM gate
      color_conformance.e2e.js   # color patch gate
      export_10bit.e2e.js        # 10-bit: tags + distinct-step + AV1-10 source + 4K ring cap + reorder-tail
      export_range_audio.e2e.js  # range + audio-settings gate
      export_overlap_same_source.e2e.js  # same-source overlap decode gate
      export_eos_tail.e2e.js     # end-of-stream drain + audio-overhang gate
      export_content_modes.e2e.js  # audio-only / no-audio / wrong-content error paths
    audio/
      audio.e2e.js               # audio conformance + format matrix + envelope
    motif/
      capture.e2e.js             # CDP capture determinism + lower-third + live preview
      state.e2e.js               # staleness notice + bake-status dot + file-watch
      export.e2e.js              # motif renders + animates in export
      prebake.e2e.js             # L2 pre-bake disk round-trip + GC
    helpers/userMotifFs.mjs      # user-Motif draft/install fs helper (motif specs)
  tools/
    perf_export_redundancy.e2e.js  # non-gating decode-dispatch measurement
    iso_tenbit_gl_parity.e2e.js    # f16 ingest/pack shaders vs yuv10.ts reference
    iso_video_sink_throughput.e2e.js  # loopback-WS sink transport spike
    iso_transport_matrix.e2e.js    # WS-wall decomposition (webview vs Rust side)
  lib/analyze.mjs                # Node wrapper around Rust analyzer
apps/desktop/src-tauri/src/bin/
  media_conformance.rs           # ffmpeg-backed analyzer binary
```

`WEFTCUT_TEST_MEDIA` can point the E2E specs at an external fixture directory;
otherwise they use `apps/desktop/e2e/fixtures/media`.

## Fixture Generation

`generate.go` creates deterministic clips for the matrix. `generate-fixtures.mjs`
is the single source of truth for which files belong in the matrix; `wdio.conf.mjs`
calls `ensureFixtures` on prepare so a fresh checkout materializes any missing
clips before the suite runs. Requires `go` and `ffmpeg` on PATH.

| Clip family | Examples | Used by |
|---|---|---|
| Counter-burned H.264 | `test_1080p_{30,60,120}fps.mp4`, `.mkv` | `conformance.e2e.js`, `export_overlap_same_source.e2e.js`, `tools/perf_export_redundancy.e2e.js` |
| EOS-tail geometry | `test_1080p_30fps_eostail.mp4` (keys at 0 s/5 s only, audio 1 s longer than video) | `export_eos_tail.e2e.js` |
| Tone-marker audio | `test_1080p_{30,60,120}fps_audio.mp4` | `audio/audio.e2e.js`, `export/export_range_audio.e2e.js` |
| Color patches | `test_1080p_color_{709ltd,601ltd,709full,601full}.mp4` + `color_manifest.json` | `color_conformance.e2e.js` |
| 10-bit gradient (HEVC) | `test_1080p_gradient10.mp4` | gradient baseline / proxy-fidelity probes |
| 10-bit gradient (Hi10P H.264) | `test_1080p_gradient10_h264.mp4`, `test_1080p_gradient10_h264_bf.mp4` (long-GOP + B-frames), `test_2160p_gradient10_h264.mp4` (4K ring-cap case) | `export_10bit.e2e.js`, `tools/iso_tenbit_gl_parity.e2e.js`, `tools/float16_probes.e2e.js` |
| 10-bit gradient (AV1) | `test_1080p_gradient10_av1.mp4` (SVT-AV1) | `export_10bit.e2e.js` (AV1-10 source admission) |
| ProRes MOV | `test_1080p_30fps_prores.mov` | import routing smoke (not a conformance gate) |
| Still-image chart set | `test_chart_320x240.{png,jpg,webp,bmp,gif,tiff}` + `_manifest.json` | `ui/layers.e2e.js` |
| Audio-only tone files | `test_tones_10s.{wav,mp3,flac,m4a,ogg}` (mp3 embeds cover art) | `audio/audio.e2e.js` |
| Animated GIF | `test_1080p_10fps.gif` | `ui/layers.e2e.js` (Video-routing leg) |

The generator, matrix script, baselines, and `.gitkeep` are tracked. Generated
media is written to the repo-local `apps/desktop/e2e/fixtures/media` directory
but ignored by git, so a checkout can reproduce the clips without committing
large binaries. The tiny demux fixtures under `apps/desktop/fixtures/media` are
separate unit-test fixtures for mediabunny range-reading, not the full
conformance matrix.

## Analyzer

`media_conformance` uses `ffmpeg-sidecar`'s ffmpeg path and has three modes:

- Default video mode: decode output/source frames at requested sample indices,
  find the best source match within a small window, and report alignment plus
  app-only conversion loss.
- `--audio`: decode output audio to mono PCM, use Goertzel analysis to detect
  each second's expected tone, and report per-second alignment, drift slope,
  offset, and SNR-style confidence.
- `--color`: decode output by its own tags and source by a forced
  matrix/range, then compare patch errors from `color_manifest.json`.

The analyzer is intentionally file-based. It validates what the user would
receive on disk, including WebCodecs encode, Rust audio export, and ffmpeg mux
or transcode.

## Gates

`conformance.e2e.js` imports a 30 fps H.264 source, exports it through the
real app, and checks that sampled frames align exactly while meeting a loose
SSIM floor. This gate caught the long-GOP export deadlocks and the rational
frame-grid off-by-one that produced 301 frames from a 300-frame clip.

The audio conformance matrix in `audio/audio.e2e.js` runs over 30/60/120 fps
audio-bearing MP4 sources and `mp4`/`mkv`/`mov` export containers. It verifies
per-second tone markers, drift slope, and offset through the complete video
export, Rust audio, and mux pipeline. (`audio/audio.e2e.js` also holds the
audio-only format matrix and the envelope-shaping gate described below.)

`export_range_audio.e2e.js` reuses the 30 fps tone-marker fixture to verify
range export trims audio at the requested source time, exercises AAC/Opus and
muted export settings, and checks the software video-encoder path with frame
alignment diagnostics.

`export_eos_tail.e2e.js` exports the EOS-tail fixture, whose final GOP spans
multiple export chunks and whose audio outlasts the video by a second. It
gates the end-of-stream deadlock class: the export must complete (the
deadlocks pinned the frame counter), plan the audio-extended frame count, and
keep the flush-drained tail region frame-aligned.

`export_overlap_same_source.e2e.js` gates same-source overlap decoding:
two stacked enabled copies of one media must export complete, frame-aligned,
and at no extra decode dispatch vs a single-clip baseline (same-phase clips
share a merged-range pipeline — see [`render.md`](render.md)); a 2 s-offset
copy must complete with each clip on its own source frames (the overlap
region best-matches the shifted index). The pre-fix failure was a frame
counter frozen mid-export.

`tools/perf_export_redundancy.e2e.js` is a non-gating companion: it reports
decode dispatch against the inherent floor for single-clip, sequential
re-use, different-phase overlap, and mid-GOP range-entry timelines via the
worker's `__weftcutExportPerf` counters.

The audio-only format matrix in `audio/audio.e2e.js` runs audio-ONLY sources
(wav/mp3/flac/m4a/ogg tone files) through import → conform → Audio layer →
export mix and verifies the
same tone markers. The format RANGE itself is pinned cheaply by the Rust unit
matrix (`jobs::conform::tests::conform_format_matrix_against_real_ffmpeg`);
this gate proves the audio-only pipeline. The mp3 fixture embeds attached_pic
cover art — the regression fixture for `probe::detect_kind`'s cover-art skip.

The still-image leg of `ui/layers.e2e.js` imports the color-patch chart in every
dialog-offered still format, places ImageOverlays, and samples patch centers off the live
composite (the same `fetch` → `createImageBitmap` → Pixi texture path export
uses). TIFF is asserted as the documented-unsupported negative (composites
nothing); the animated GIF leg asserts multi-frame GIF classifies as Video and
reaches an export-ready proxy route. Classification itself is unit-pinned in
`io::probe::tests` (captured ffprobe JSON + a real-ffprobe integration test).

`color_conformance.e2e.js` exports the color patch fixtures and compares
perceptual app-only color error. All four encodings (709/601 × limited/full)
are expected faithful and DirectExport from the original (`yuvj420p` is on the
browser-friendly whitelist). Proxy-routed sources keep their color through the
self-describing proxy recipes — source tags asserted + the mp4 `colr` atom
written (mediabunny never parses the SPS VUI), with ffprobe source tags also
threaded into proxy decodes as the colr-less fallback; that machinery is
guarded by the Rust test `proxy_carries_source_color_tags_and_colr_atom`. See
ADR 0014.

## Running

From `apps/desktop/e2e` (after `npm install`):

Specs are grouped into five suites — `smoke`, `ui`, `export`, `audio`, `motif` —
so you can run just the area you are working on instead of the whole matrix.

```bash
# Full suite (builds debug app with VITE_WEFTCUT_E2E=1, generates fixtures)
npm run e2e

# One suite (fetches the driver, then runs only that group)
npm run e2e:ui        # or: e2e:smoke | e2e:export | e2e:audio | e2e:motif

# Reuse an already-built debug binary across runs (skip the tauri build).
# Build once without it, then iterate fast. Errors out if the binary is absent.
WEFTCUT_E2E_NO_BUILD=1 npm run e2e:ui            # bash
$env:WEFTCUT_E2E_NO_BUILD=1; npm run e2e:ui      # PowerShell

# One gate — call the wdio bin directly. On Windows, `npm run test -- --spec`
# and `npx wdio ... --spec` BOTH silently drop the --spec filter (PowerShell
# eats the bare `--`; npm/npx claim the flag as config) and run every spec.
node node_modules/@wdio/cli/bin/wdio.js run wdio.conf.mjs --spec specs/export/conformance.e2e.js
```

The `e2e:*` scripts go through `scripts/run-suite.mjs`, which spawns the wdio bin
directly so the `--suite` flag survives the same Windows `--`-swallowing trap that
bites `--spec`. Verify the log opens with `Execution of 1 workers` when running a
single-file suite (smoke/audio); a multi-file suite reports one worker per file.

The harness builds `apps/desktop/src-tauri/target/debug/weftcut.exe` with the
E2E hook (`window.__weftcutTest`) compiled in, starts `tauri-driver` against a
matching `msedgedriver`, and drives the real WebView2 shell. Analyzer calls go
through `lib/analyze.mjs`, which shells the `media_conformance` binary built
alongside the app.

To regenerate fixtures without running tests:

```bash
node apps/desktop/e2e/fixtures/generate-fixtures.mjs
```

## Decode Color Tags

The product-side color fix is in the decode path, not in the analyzer.
`io/probe.rs` extracts ffprobe color tags into `MediaSummary`; the webview maps
them via `ffprobeColorToWebCodecs`; `withDefaultColorSpace` fills missing
fields with this priority:

1. mediabunny's bitstream/VUI color tag.
2. ffprobe's source/container color tag.
3. A resolution-keyed SDR default: HD -> BT.709, SD -> SMPTE 170M, limited
   range.

`SourceDecoderPool` and `ExportDecoderPool` both apply that merged
`VideoColorSpaceInit` before decode. `VideoClipSprite` snapshots through a 2D
canvas because that path honors `VideoFrame.colorSpace`; the zero-copy WebGPU
upload path is deferred in [`roadmap.md`](roadmap.md).
