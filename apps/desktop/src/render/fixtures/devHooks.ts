// Devtools-only hooks for fixture authoring. Attaches a couple of
// helper functions to `window` so a fixture author can drive the
// runner from the browser console without building a UI surface.
// Side-effect import; no exports.
//
// Loop for generating baselines (P10a):
//   1. Boot the desktop app with the pixi preview enabled (?pixi=1
//      URL param or the localStorage flag in `pixiPreviewFlag.ts`).
//   2. Open DevTools.
//   3. Call `await window.__weftcut_generate_baselines("/abs/path/to/fixture")`.
//      Resolves with the absolute paths of the PNGs written to
//      `<fixture>/expected/t_<us>.png`.
//   4. Inspect the PNGs. If they look right, `git add fixtures/<NNN>_…/`
//      and commit. If not, fix the fixture or the renderer + re-run.
//
// P10b replaces this with a CI-driven Rust binary that does the same
// thing without devtools. Keep the hooks around indefinitely — local
// re-baselining stays useful for one-off changes.

import { generateBaselines, runFixture } from "./runFixture";

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    __weftcut_generate_baselines?: typeof generateBaselines;
    __weftcut_run_fixture?: typeof runFixture;
  }
}

if (typeof window !== "undefined") {
  window.__weftcut_generate_baselines = generateBaselines;
  window.__weftcut_run_fixture = runFixture;
}
