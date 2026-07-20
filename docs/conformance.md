# Conformance

The conformance suite verifies that the real app export path preserves frame
alignment, audio sync, and color behavior. It is separate from the colocated
renderer unit tests under `apps/desktop/src/render/**` and the tiny demux fixtures
in `apps/desktop/fixtures/media`: these tests drive the real Electron renderer
(Playwright `_electron`), import real media, export through the Pixi/WebCodecs +
Rust ffmpeg pipeline, and analyze the resulting file.

This doc covers the analyzer, fixtures, and per-gate behavior. For how the suite
is organized into runnable groups and where a new test belongs, see the authoring
guide at [`apps/desktop/e2e/README.md`](../apps/desktop/e2e/README.md).

## Layout

```text
apps/desktop/
  playwright.config.ts           # Playwright runner (testDir: e2e/electron)
  e2e/
    electron/                    # the live suite — *.spec.ts (Playwright _electron)
      conformance.spec.ts          # video frame alignment + SSIM gate
      color-conformance.spec.ts    # color patch gate (709/601 x limited/full)
      audio.spec.ts                # audio conformance + format matrix + envelope + roles
      export-range-audio.spec.ts   # range + audio-settings gate
      export_codecs.spec.ts        # AV1 / HEVC / 10-bit HEVC export smoke
      export_eos_tail.spec.ts      # end-of-stream drain + audio-overhang gate
      export_overlap_same_source.spec.ts  # same-source overlap decode gate
      determinism.spec.ts          # cross-OS motif-capture SSIM
      motif-*.spec.ts              # capture / preview / export / lifecycle / protocol
      mcp-*.spec.ts, media-*.spec.ts, fs-guard, cloud-keys, smoke, ...
      helpers/driver.ts            # launchApp / newProject / driveExport / waitForHook /
                                   #   invokeCmd / summary / importAndPlaceMedia / placeMediaLayer
    lib/
      analyze.mjs                  # Node wrapper around the Rust analyzer
      image-ssim.mjs, compare-determinism.mjs   # determinism-capture comparison
    fixtures/
      generate.mjs                 # deterministic Node media fixture producer
      generate-fixtures.mjs        # orchestrator (npm run fixtures)
      color_baseline.json          # expected color error for the color encodings
      gradient_baseline.json       # expected error for the 10-bit gradient fixture
      media/                       # generated clips (gitignored); WEFTCUT_TEST_MEDIA overrides
        color_manifest.json        # patch layout for color-conformance (generated)
        .gitkeep
    scripts/                       # standalone color diagnostics (color-*.mjs)
  native/src/bin/
    media_conformance.rs           # ffmpeg-backed analyzer binary
```

Backend commands are driven from a spec via `window.api.backend.invoke(cmd, args)`
(the renderer bridge), wrapped by `driver.ts`'s `invokeCmd` / `summary`. The
import→place→export flow goes through the dev-only `window.__weftcutTest` hook
(see [`apps/desktop/e2e/README.md`](../apps/desktop/e2e/README.md)).

`WEFTCUT_TEST_MEDIA` can point the E2E specs at an external fixture directory;
otherwise they use `apps/desktop/e2e/fixtures/media`.

## Fixture Generation

`generate.mjs` creates deterministic clips for the matrix.
`generate-fixtures.mjs` is the single source of truth for which files belong in
the matrix; run it with `npm run fixtures` (from `apps/desktop/e2e`) to
materialize any missing clips — it is idempotent. Both scripts use only Node
built-ins and invoke `ffmpeg` without a command shell, so output directories
with spaces and native Windows paths are preserved. The Playwright run does
**not** auto-generate fixtures (there is no global-setup step), so generate them
before running the analyzer-backed gates. Requires `ffmpeg` on PATH.

For a single recipe, run `node fixtures/generate.mjs --help` from
`apps/desktop/e2e`; `--output-dir` accepts any native path. The fast
`npm run test:fixtures` regression covers every matrix recipe without invoking
real encoders.

| Clip family | Examples | Used by |
|---|---|---|
| Counter-burned H.264 | `test_1080p_{30,60,120}fps.mp4`, `.mkv` | `conformance.e2e.js`, `export_overlap_same_source.e2e.js` |
| EOS-tail geometry | `test_1080p_30fps_eostail.mp4` (keys at 0 s/5 s only, audio 1 s longer than video) | `export_eos_tail.e2e.js` |
| Tone-marker audio | `test_1080p_{30,60,120}fps_audio.mp4` | `audio.spec.ts`, `export/export_range_audio.e2e.js` |
| Color patches | `test_1080p_color_{709ltd,601ltd,709full,601full}.mp4` + `color_manifest.json` | `color_conformance.e2e.js` |
| 10-bit gradient (HEVC) | `test_1080p_gradient10.mp4` | gradient baseline / proxy-fidelity probes |
| 10-bit gradient (Hi10P H.264) | `test_1080p_gradient10_h264.mp4`, `test_1080p_gradient10_h264_bf.mp4` (long-GOP + B-frames), `test_2160p_gradient10_h264.mp4` (4K ring-cap case) | `export_10bit.e2e.js` |
| 10-bit gradient (AV1) | `test_1080p_gradient10_av1.mp4` (SVT-AV1) | `export_10bit.e2e.js` (AV1-10 source admission) |
| ProRes MOV | `test_1080p_30fps_prores.mov` | import routing smoke (not a conformance gate) |
| Still-image chart set | `test_chart_320x240.{png,jpg,webp,bmp,gif,tiff}` + `_manifest.json` | `ui/layers.e2e.js` |
| Audio-only tone files | `test_tones_10s.{wav,mp3,flac,m4a,ogg}` (mp3 embeds cover art) | `audio.spec.ts` |
| Animated GIF | `test_1080p_10fps.gif` | `media-gif-animated.spec.ts` (Image classification, loop/frame-bind, export animation) |

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
receive on disk, including WebCodecs encode, the native ffmpeg encode sink,
Rust audio export, and the final mux.

## Gates

`conformance.spec.ts` imports a 30 fps H.264 source, exports it through the
real app, and checks that sampled frames align exactly while meeting a loose
SSIM floor. This gate caught the long-GOP export deadlocks and the rational
frame-grid off-by-one that produced 301 frames from a 300-frame clip.

The audio conformance matrix in `audio.spec.ts` runs over 30/60/120 fps
audio-bearing MP4 sources and `mp4`/`mkv`/`mov` export containers. It verifies
per-second tone markers, drift slope, and offset through the complete video
export, Rust audio, and mux pipeline. (`audio.spec.ts` also holds the
audio-only format matrix and the envelope-shaping gate described below.)

`export-range-audio.spec.ts` reuses the 30 fps tone-marker fixture to verify
range export trims audio at the requested source time, exercises AAC/Opus and
muted export settings, and checks the software video-encoder path with frame
alignment diagnostics.

`export_eos_tail.spec.ts` exports the EOS-tail fixture, whose final GOP spans
multiple export chunks and whose audio outlasts the video by a second. It
gates the end-of-stream deadlock class: the export must complete (the
deadlocks pinned the frame counter), plan the audio-extended frame count, and
keep the flush-drained tail region frame-aligned.

`export_overlap_same_source.spec.ts` gates same-source overlap decoding:
two stacked enabled copies of one media must export complete, frame-aligned,
and at no extra decode dispatch vs a single-clip baseline (same-phase clips
share a merged-range pipeline — see [`render.md`](render.md)); a 2 s-offset
copy must complete with each clip on its own source frames (the overlap
region best-matches the shifted index). The pre-fix failure was a frame
counter frozen mid-export.

The audio-only format matrix in `audio.spec.ts` runs audio-ONLY sources
(wav/mp3/flac/m4a/ogg tone files) through import → conform → Audio layer →
export mix and verifies the
same tone markers. The format RANGE itself is pinned cheaply by the Rust unit
matrix (`jobs::conform::tests::conform_format_matrix_against_real_ffmpeg`);
this gate proves the audio-only pipeline. The mp3 fixture embeds attached_pic
cover art — the regression fixture for `probe::detect_kind`'s cover-art skip.

The UI-driving specs (`layers`, `keyframe_authoring`, `shortcut_focus`) are
**not yet re-homed** to the Playwright suite — they were the only specs not
ported when the wdio harness was retired, and they exercise UI that has drifted
since (the timeline redesign), so they are closer to a rewrite than a port. They
should be re-homed when their areas are next touched (originals are in git
history before the retirement commit `e1321538`); the still-image / animated-GIF
classification they covered remains unit-pinned in `io::probe::tests` (captured
ffprobe JSON + a real-ffprobe integration test) meanwhile.

`color-conformance.spec.ts` exports the color patch fixtures and compares
perceptual app-only color error. All four encodings (709/601 × limited/full)
are expected faithful and DirectExport from the original (`yuvj420p` is on the
browser-friendly whitelist). Proxy-routed sources keep their color through the
self-describing proxy recipes — source tags asserted + the mp4 `colr` atom
written (mediabunny never parses the SPS VUI), with ffprobe source tags also
threaded into proxy decodes as the colr-less fallback; that machinery is
guarded by the Rust test `proxy_carries_source_color_tags_and_colr_atom`. See
ADR 0014.

## Running

The suite is Playwright `_electron`: it launches the **built** Electron app
(`out/main/index.js`) and drives the real renderer. There is no separate driver
to fetch and no single-instance lock to clear — each test launches its own app
instance.

**Prerequisites** (run once, or when stale). From `apps/desktop` unless noted:

```bash
npm run napi:build                    # build the @weftcut/core native addon
npm run ffmpeg:fetch                   # ffmpeg on PATH (or use a system ffmpeg)
( cd e2e && npm run fixtures )         # generate test media (needs ffmpeg)
VITE_WEFTCUT_E2E=1 npm run build       # build WITH the E2E hook — see warning
```

> **`VITE_WEFTCUT_E2E=1` on the build is mandatory.** The `window.__weftcutTest`
> control surface is gated on that flag and tree-shaken from any other build, so
> a plain `npm run build` leaves every export spec timing out in `waitForHook`
> (30 s) with no other symptom. Use a bash shell so the inline env-var prefix
> works on Windows (this is what CI does).

Then, from `apps/desktop`:

```bash
npm run e2e                                            # full suite
npm run e2e -- color-conformance.spec.ts               # one file
npm run e2e -- -g "role"                               # by title grep
```

Analyzer calls go through `lib/analyze.mjs`, which shells
`cargo run --bin media_conformance --features jobs,export`; the first run
compiles the binary, later runs reuse it. The analyzer-backed gates
(`conformance`, `color-conformance`, `audio`, `export-range-audio`) therefore
**run locally only and skip in CI**, which builds + launches the app and runs
the determinism + non-fixture specs but generates no fixtures and does not build
the analyzer (`electron-ci.yml`). To make any of them a true CI gate, add a
fixtures + `cargo` step to the workflow.

To regenerate fixtures without running tests, `npm run fixtures` from
`apps/desktop/e2e` (or `node apps/desktop/e2e/fixtures/generate-fixtures.mjs`).

## Decode Color Tags

The product-side color fix is in the decode path, not in the analyzer.
`io/probe.rs` extracts ffprobe color tags into `MediaSummary`; the renderer maps
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
