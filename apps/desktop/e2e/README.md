# WeftCut E2E suite — authoring & maintenance guide

These tests drive the **real packaged Electron app** (via Playwright's Electron
support), exercising the actual PixiJS/WebCodecs renderer + Rust (napi) ffmpeg
pipeline the product ships on. They are the engine-fidelity gates.

Run from `apps/desktop`:

```
npm run e2e:electron        # the full Playwright suite (playwright.config.ts)
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
migration. Most of its specs were ported to `electron/` (conformance, export
eos-tail / overlap / codecs, motif capture/state/export, smoke, s2–s6). A few
were **not yet ported** and should be re-homed as Playwright specs when their
areas are next touched (originals recoverable from git history before the
retirement commit):

- **audio** — `audio.e2e.js` (export conformance + format matrix + envelope)
- **ui** — `keyframe_authoring`, `layers`, `shortcut_focus`
- **export** — `color_conformance`, `export_range_audio`
