# WeftCut E2E suite — authoring & maintenance guide

These tests drive the **real packaged Electron app** (via Playwright's Electron
support), exercising the actual PixiJS/WebCodecs renderer + Rust (napi) ffmpeg
pipeline the product ships on. They are the engine-fidelity gates.

### Prerequisites (run once / when stale)

The export-driving specs need four things in place, or they fail loudly (or
skip). From `apps/desktop` unless noted:

```bash
npm run napi:build                         # build the @weftcut/core native addon
npm run fetch-ffmpeg                        # ffmpeg on PATH (or use a system ffmpeg)
( cd e2e && npm run fixtures )              # generate test media (needs ffmpeg + go)
VITE_WEFTCUT_E2E=1 npm run build            # MUST set the flag — see below
```

- **`VITE_WEFTCUT_E2E=1` on the build is mandatory.** Without it the
  `window.__weftcutTest` control surface is tree-shaken out of the bundle, and
  every export spec times out in `waitForHook` (30 s) with no other symptom. Use
  a bash shell so the inline env-var prefix works on Windows.
- **Fixtures are not auto-generated.** The Playwright run has no global-setup
  step, so `npm run fixtures` must have been run (it is idempotent — skips files
  that already exist). `media/` is gitignored; point elsewhere with
  `WEFTCUT_TEST_MEDIA`.
- **The analyzer-backed gates need a buildable `cargo`.** `lib/analyze.mjs`
  shells `cargo run --bin media_conformance --features jobs,export`; the first
  invocation compiles it (slow), later runs reuse the binary. These gates
  (`conformance`, `color-conformance`, `audio`, `export-range-audio`) therefore
  run **locally only** and skip in CI, which generates no fixtures.
- **`export-native-wedges.spec.ts` (native export decode wedge gates) needs an
  extra run flag:** build with the standard `VITE_WEFTCUT_E2E=1 npm run build`
  and run with `WEFTCUT_DECODE_E2E=1` — it replays the historical export wedge
  shapes (same-source overlap, backward clip reuse, EOS tail, credit stall) on
  the native in-process ffmpeg export decode path. No build flag: routing is
  settings-driven — the default `decodeEngine: "auto"` routes WebCodecs-blind
  sources native whenever the native-decode component is present.

### Run

```
npm run e2e:electron        # the full Playwright suite (playwright.config.ts)
npm run e2e:electron -- color-conformance.spec.ts        # one file
npm run e2e:electron -- -g "role"                         # by title grep
```

The Rust analyzer (`media_conformance`) used by the export/conformance specs,
fixture generation, and per-gate details are documented in
[`../../../docs/conformance.md`](../../../docs/conformance.md).

From this directory (`apps/desktop/e2e`), a separate local-only benchmark:

```
npm run bench:decode        # decode-strategy benchmark (see ../../../docs/decode-bench.md)
```

## Layout

```
electron/            Playwright specs (*.spec.ts) — the live suite
electron/helpers/    driver.ts: launchApp / newProject / driveExport / waitForHook
lib/                 analyzer + comparison: analyze.mjs (media_conformance),
                     compare-determinism.mjs, image-ssim.mjs
fixtures/            generate-fixtures.mjs (real test media via ffmpeg);
                     media/ is generated, gitignored
scripts/             standalone color diagnostics (color-*.mjs) — invoke
                     cargo media_conformance / ffmpeg directly, not the suite;
                     decode-bench.mjs + gen-decode-bench-fixtures.mjs (the
                     decode-strategy benchmark, see ../../../docs/decode-bench.md)
tools/               one-shot probes/experiments (color isolation, float16,
                     10-bit GL parity, export-redundancy perf)
```

Specs are separate from the colocated renderer **unit** tests
(`apps/desktop/src/**/*.test.ts`, Vitest), which mock the browser surface and
cover pure logic — put fast, logic-only checks there, not here.

## Fixtures

`npm run fixtures` (from this dir) materializes the test media into
`fixtures/media/` (needs `ffmpeg` on PATH). Point at an external set with
`WEFTCUT_TEST_MEDIA`. See `docs/conformance.md`.

The waveform/alignment pair (`test_audio_timing_zero_pts.mkv` and
`test_audio_timing_offset_375ms.mkv`) contains 250 ms sound islands at source
times 1 s, 3 s, and 5 s. The files differ only by a shared A/V first-PTS offset;
`audio-waveform-alignment.spec.ts` compares the generated waveform with the
conform PCM consumed by preview playback, after both background jobs settle.
The 125 s companion (`test_audio_timing_long_125s.mkv`) has 500 ms sound
islands at 5 s, 60 s, and 120 s. The same spec samples it through the real tile
producer at 80, 15, and 8 px/s, covering the roughly 62.64, 15.66, and 7.83
peaks/s LODs where an integer peaks/s timebase used to accumulate severe drift.

## The dev control surface

The specs drive `apps/desktop/src/testhook/e2eHook.ts` (`window.__weftcutTest`),
gated on `VITE_WEFTCUT_E2E=1` and tree-shaken from production. Build with that
env set so the hook mounts. Add a new hook there when a spec needs to drive
something the UI does but a spec can't reach directly.

## Coverage TODO — un-ported from the retired wdio suite

The old wdio/`tauri-driver` suite was retired with the Tauri → Electron
migration. Most of its specs were ported to `electron/` (conformance, color
conformance, audio, export range/audio, eos-tail / overlap / codecs, motif
capture/state/export, smoke, s2–s6). The analyzer-backed gates were re-homed as
`color-conformance.spec.ts`, `audio.spec.ts`, and `export-range-audio.spec.ts`,
reusing the surviving `lib/analyze.mjs` + `fixtures/`. What remains **not yet
ported** are the UI-driving specs, which should be re-homed when their areas are
next touched — they exercise UI that has since drifted (timeline redesign), so
they're closer to a rewrite than a port (originals recoverable from git history
before the retirement commit `e1321538`):

- **ui** — `keyframe_authoring`, `layers`, `shortcut_focus`
- **image** — `image_support`'s still-image composite matrix (png/jpg/webp/bmp
  sampled off the live preview + the tiff-stays-empty negative). Its gif=Video
  full-proxy routing leg IS ported, as `media-gif-routing.spec.ts`.

Like `conformance.spec.ts`, the analyzer-backed gates run **locally** (they need
`npm run fixtures` + a buildable `cargo media_conformance`) and skip in CI,
which generates no fixtures.

## Known flakes

### `fs-guard.spec.ts` — "fs:writeFile honors append vs truncate" (Windows, under load)

**Symptom.** Occasionally fails inside the *full* suite run on Windows; passes
deterministically when run in isolation (`npm run e2e:electron -- fs-guard.spec.ts`).

**Not a logic bug.** The write path is synchronous — `fs:writeFile` does
`fs.appendFileSync`/`fs.writeFileSync` (`src/main/index.ts`), so the fd is closed
+ flushed before the IPC resolves; there is no write-then-read race to "wait out".
The test then reads the file *cross-process* from the Playwright runner
(`fs.readFileSync(tmp)` at `fs-guard.spec.ts:23`).

**Hypothesised cause (unconfirmed — the exact failing assertion has not been
captured).** A Windows external transient under the heavy I/O of the full run
(many temp files from export/proxy/motif specs): Defender or the Search indexer
briefly locks the temp file, surfacing as `EBUSY` on main's `appendFileSync` or a
sharing violation on the runner's `readFileSync`.

**CI impact — buffered, not immune.** `playwright.config.ts` sets
`retries: process.env.CI ? 1 : 0`. GitHub Actions sets `CI=true`, so CI retries
once and a single flake stays green; it would only go red on two consecutive
failures (rare for a low-frequency flake). **Local `retries: 0`** is why it
surfaces locally. **Decision: left as-is** (low-frequency, CI-buffered).

**Fix approach if it recurs** (do this, NOT a fixed `sleep` — there is no async
race to delay for, and a blind delay slows every run):

1. First **capture the real failure** — re-run the full suite a few times until it
   reproduces and note *which* assertion fails (`[1,2,3,4,5]` equality, `exists`,
   or `remove`) and the error. Fix the actual cause, not the hypothesis.
2. Make the cross-process read **condition-polled** instead of one-shot — replace
   the single `expect(Array.from(fs.readFileSync(tmp)))` with an
   `expect.poll(() => Array.from(fs.readFileSync(tmp)))` on a tight timeout so a
   momentary lock/short-read is retried, not failed. (Condition-based waiting, not
   an arbitrary timer.)
3. Do **not** flip local `retries` to 1 — that masks *all* local flakes and hides
   real regressions during development.
