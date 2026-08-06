import { defineConfig } from '@playwright/test'

/// `@matrix` marks a combinatorial cell whose axes are already covered
/// individually by the cells that stay (see audio.spec.ts), or a low-churn
/// specialty target (see export_codecs.spec.ts). They are the expensive part of
/// the suite — every one drives a real encode — and they are excluded by
/// default so the per-PR run stays inside the job budget. `WEFTCUT_E2E_FULL=1`
/// puts them back; electron-ci sets it on its scheduled sweep, and
/// `npm run e2e -- --full` is the local equivalent.
///
/// This is a project-level grepInvert rather than a CLI `--grep-invert` so the
/// command line stays free for a developer to filter with, and so it composes
/// with the serial/parallel split below instead of overwriting it.
const MATRIX_EXCLUDED = process.env.WEFTCUT_E2E_FULL ? [] : [/@matrix/]

export default defineConfig({
  testDir: 'e2e/electron',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
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
      workers: process.env.CI ? 2 : '50%',
    },
  ],
})
