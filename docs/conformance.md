# Conformance

The conformance suite verifies that the real app export path preserves frame
alignment, audio sync, and color behavior. It is separate from the renderer
fixture suite in `render/fixtures`: these tests drive WebView2, import real
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
  specs/
    conformance.e2e.js           # video frame alignment + SSIM gate
    audio_conformance.e2e.js     # audio matrix gate
    export_range_audio.e2e.js    # range + audio-settings gate
    color_conformance.e2e.js     # color patch gate
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
| Counter-burned H.264 | `test_1080p_{30,60,120}fps.mp4`, `.mkv` | `conformance.e2e.js` |
| Tone-marker audio | `test_1080p_{30,60,120}fps_audio.mp4` | `audio_conformance.e2e.js`, `export_range_audio.e2e.js` |
| Color patches | `test_1080p_color_{709ltd,601ltd,709full,601full}.mp4` + `color_manifest.json` | `color_conformance.e2e.js` |
| 10-bit gradient | `test_1080p_gradient10.mp4` | gradient baseline / proxy-fidelity probes |
| ProRes MOV | `test_1080p_30fps_prores.mov` | import routing smoke (not a conformance gate) |

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

`audio_conformance.e2e.js` runs a matrix over 30/60/120 fps audio-bearing MP4
sources and `mp4`/`mkv`/`mov` export containers. It verifies per-second tone
markers, drift slope, and offset through the complete video export, Rust audio,
and mux pipeline.

`export_range_audio.e2e.js` reuses the 30 fps tone-marker fixture to verify
range export trims audio at the requested source time, exercises AAC/Opus and
muted export settings, and checks the software video-encoder path with frame
alignment diagnostics.

`color_conformance.e2e.js` exports the color patch fixtures and compares
perceptual app-only color error. Limited-range 709/601 encodings are expected
to be faithful. Full-range encodings are currently known-bad and remain a
roadmap item; the gate asserts the known-bad state so it flips red when the
proxy/full-range fix lands and the baseline can be updated.

## Running

From `apps/desktop/e2e` (after `npm install`):

```bash
# Full suite (builds debug app with VITE_WEFTCUT_E2E=1, generates fixtures)
npx wdio run ./wdio.conf.mjs

# One gate
npx wdio run ./wdio.conf.mjs --spec ./specs/conformance.e2e.js
```

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
