import { defineConfig } from '@playwright/test'
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
    { name: 'serial', grep: /@serial/, workers: 1 },
    { name: 'parallel', grepInvert: /@serial/, workers: process.env.CI ? 2 : '50%' },
  ],
})
