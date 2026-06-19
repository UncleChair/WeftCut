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

### Run

```
npm run e2e:electron        # the full Playwright suite (playwright.config.ts)
npm run e2e:electron -- color-conformance.spec.ts        # one file
npm run e2e:electron -- -g "role"                         # by title grep
```

The Rust analyzer (`media_conformance`) used by the export/conformance specs,
fixture generation, and per-gate details are documented in
[`../../../docs/conformance.md`](../../../docs/conformance.md).

## Layout

```
electron/            Playwright specs (*.spec.ts) — the live suite
electron/helpers/    driver.ts: launchApp / newProject / driveExport / waitForHook
lib/                 analyzer + comparison: analyze.mjs (media_conformance),
                     compare-determinism.mjs, image-ssim.mjs
fixtures/            generate-fixtures.mjs (real test media via ffmpeg);
                     media/ is generated, gitignored
scripts/             standalone color diagnostics (color-*.mjs) — invoke
                     cargo media_conformance / ffmpeg directly, not the suite
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

Like `conformance.spec.ts`, the analyzer-backed gates run **locally** (they need
`npm run fixtures` + a buildable `cargo media_conformance`) and skip in CI,
which generates no fixtures.
