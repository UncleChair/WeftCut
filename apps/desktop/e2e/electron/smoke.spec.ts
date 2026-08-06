import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

test('boots, creates a project, add_track round-trips through the bridge', async () => {
  // Launch the built app through the shared driver (isolated throwaway
  // userData; launchApp awaits firstWindow + domcontentloaded).
  const { app, page } = await launchApp()

  // Capture baseline track_count (blank project boots with 2 reserved A/B-roll
  // tracks; do NOT hardcode a literal count here).
  const summary0 = await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))
  const baseline: number = summary0.track_count
  expect(typeof baseline).toBe('number')

  const addTrackResult = await page.evaluate(() => (window as any).api.backend.invoke('add_track', {}))
  expect(typeof addTrackResult).toBe('string')

  const summary1 = await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))
  expect(summary1.track_count).toBe(baseline + 1)

  await app.close()
})
