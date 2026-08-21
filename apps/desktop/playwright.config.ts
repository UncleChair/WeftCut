import { defineConfig } from '@playwright/test'

/// `@matrix` marks the nightly-only tier — combinatorial cells and low-churn
/// specialty targets excluded from the per-PR run (what earns the tag, and what
/// must not: e2e/README.md §Tiers). `WEFTCUT_E2E_FULL=1` puts them back;
/// electron-ci sets it on its scheduled sweep, and `npm run e2e -- --full` is
/// the local equivalent.
///
/// This is a project-level grepInvert rather than a CLI `--grep-invert` so the
/// command line stays free for a developer to filter with, and so it composes
/// with the serial/parallel split below instead of overwriting it.
const MATRIX_EXCLUDED = process.env.WEFTCUT_E2E_FULL ? [] : [/@matrix/]

/// The two halves of how electron-ci splits one e2e run across runners: a leg
/// either OWNS a named set of spec files (`WEFTCUT_E2E_ONLY`) or takes
/// everything the owning legs did not (`WEFTCUT_E2E_IGNORE`). Only the heavy
/// names are maintained, in that one workflow step; a new spec joins the
/// catch-all leg on its own.
///
/// Deliberately not Playwright's `--shard`: it balances by TEST COUNT, and this
/// suite's cost distribution defeats that. One file is a quarter of the run and
/// dozens are under a minute, so the measured 3-way split left a runner idle at
/// 4 minutes while another ran 32 — 1.7x for three machines.
///
/// LANDMINE — globs, never Playwright's positional file filter. That filter is a
/// REGEX over the path, so `audio.spec.ts` also selects
/// `export-range-audio.spec.ts` and the two legs silently run it twice. A
/// `**/name` glob matches the one file it names.
const globs = (names: string | undefined) =>
  (names ?? '')
    .split(',')
    .filter(Boolean)
    .map((name) => `**/${name}`)
const OWNED = globs(process.env.WEFTCUT_E2E_ONLY)
const IGNORED = globs(process.env.WEFTCUT_E2E_IGNORE)

export default defineConfig({
  testDir: 'e2e/electron',
  testMatch: OWNED.length ? OWNED : undefined,
  testIgnore: IGNORED,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  /// A JSON report rides alongside the console reporter because it is the only
  /// durable record of what the suite costs: `stats` carries the invocation's
  /// wall clock, every test result its own `duration`, `workerIndex`, and
  /// `startTime`. Nothing else here does — CI's default `dot` prints no
  /// per-test time at all, and Playwright's built-in slow-test warning cannot
  /// fire on a single test, its 5-minute default threshold sitting well above
  /// the 60 s `timeout` above.
  ///
  /// The path must stay OUT of `outputDir` (test-results/): Playwright clears
  /// that at the start of every run, and an unscoped `npm run e2e` invokes
  /// Playwright twice (serial, then parallel) — the serial report would not
  /// survive. For the same reason scripts/run-e2e.mjs gives each invocation its
  /// own file via `PLAYWRIGHT_JSON_OUTPUT_FILE`, which outranks this value;
  /// what is written here is what a bare `npx playwright test` produces.
  reporter: [[process.env.CI ? 'dot' : 'list'], ['json', { outputFile: 'e2e-report/e2e.json' }]],
  /// Generate any missing fixture media before workers boot (see
  /// e2e/global-setup.ts). Idempotent — a warm checkout is a fast no-op.
  globalSetup: './e2e/global-setup.ts',
  /// Project split: `serial` holds the specs that must own the machine
  /// (GPU/HW-lane, perf-measurement, determinism capture — tagged `@serial`
  /// in the test title). `scripts/run-e2e.mjs` runs this project to completion
  /// before starting `parallel`; Playwright otherwise schedules independent
  /// projects concurrently even when one declares `workers: 1`.
  /// Fresh throwaway userData per launchApp() (auto-removed on app.close()) is
  /// what makes the parallel project safe.
  projects: [
    { name: 'serial', grep: /@serial/, grepInvert: MATRIX_EXCLUDED, workers: 1 },
    {
      name: 'parallel',
      grepInvert: [/@serial/, ...MATRIX_EXCLUDED],
      // GPU-less CI legs (Linux/SwiftShader, Windows/WARP) saturate their 4
      // vCPUs with ONE export pipeline — two workers starve each other into
      // the 170s export timeout. macOS runners have a real GPU; keep two.
      workers: process.env.CI ? (process.platform === 'darwin' ? 2 : 1) : '50%',
    },
  ],
})
