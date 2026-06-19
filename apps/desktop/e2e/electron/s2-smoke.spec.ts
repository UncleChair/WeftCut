import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM-safe __dirname equivalent (package.json has "type": "module")
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test('boots, creates a project, add_track round-trips through the bridge', async () => {
  // Launch the built Electron app directly via its main entry point.
  // electron-vite build emits out/main/index.js; the built renderer is in
  // out/renderer/ (loaded as a local file by the main process at runtime).
  const app = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Capture baseline track_count (blank project boots with 2 reserved A/B-roll
  // tracks; do NOT hardcode a literal count here).
  const summary0 = await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))
  const baseline: number = summary0.track_count
  expect(typeof baseline).toBe('number')

  // Invoke add_track — must return a string track-id.
  const addTrackResult = await page.evaluate(() => (window as any).api.backend.invoke('add_track', {}))
  expect(typeof addTrackResult).toBe('string')

  // After add_track, track_count must have grown by exactly 1.
  const summary1 = await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))
  expect(summary1.track_count).toBe(baseline + 1)

  await app.close()
})
