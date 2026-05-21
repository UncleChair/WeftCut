// Devtools-only hooks for fixture authoring + regression checks.
// Attaches a few helper functions to `window` so a fixture author /
// developer can drive the runner from the browser console without a
// UI surface. Side-effect import; no exports.
//
// Bootstrap loop (do once per fixture):
//   1. Boot the desktop app with the pixi preview enabled (?pixi=1
//      URL param or the localStorage flag in `pixiPreviewFlag.ts`).
//   2. Open DevTools.
//   3. `await window.__weftcut_generate_baselines("/abs/path/to/fixture")`
//      → writes baseline PNGs to `<fixture>/expected/t_<us>.png`.
//   4. Inspect the PNGs. If they look right, `git add …` and commit.
//
// Regression check loop (every change to render/**):
//   1. Same dev shell.
//   2. `await window.__weftcut_check_fixture("/abs/path/to/fixture")`
//      → returns { pass, samples: [{ tUs, score, pass, … }] }.
//   3. Or `await window.__weftcut_check_fixture_suite("/abs/path/to/fixtures")`
//      to run every fixture under that directory.
//
// A future Tauri binary (P10c) will drive the same paths without
// devtools so CI can enforce the gate. Keep the devtools hooks
// indefinitely — local re-baselining + ad-hoc spot checks stay useful.

import {
  checkFixture,
  checkFixtureSuite,
  generateBaselines,
  runFixture,
} from "./runFixture";

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    __weftcut_generate_baselines?: typeof generateBaselines;
    __weftcut_run_fixture?: typeof runFixture;
    __weftcut_check_fixture?: typeof checkFixture;
    __weftcut_check_fixture_suite?: typeof checkFixtureSuite;
  }
}

if (typeof window !== "undefined") {
  window.__weftcut_generate_baselines = generateBaselines;
  window.__weftcut_run_fixture = runFixture;
  window.__weftcut_check_fixture = checkFixture;
  window.__weftcut_check_fixture_suite = checkFixtureSuite;
}
