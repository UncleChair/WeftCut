import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// ESM-safe __dirname equivalent (package.json has "type": "module")
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Small PNG fixture (905 bytes, 320x240 color chart).  Imports as
// MediaKind::Image so no ffmpeg job is required — the gate runs without
// ffmpeg being available in CI.
const FIXTURE = path.resolve(__dirname, '../../e2e/fixtures/media/test_chart_320x240.png')

test('import_media adds media to the pool and registers job events', async () => {
  test.skip(!fs.existsSync(FIXTURE), `fixture missing: ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`)

  const app = await electron.launch({ args: [path.resolve(__dirname, '../../out/main/index.js')] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Subscribe to media:job_* events BEFORE importing so we catch the burst.
  await page.evaluate(() => {
    ;(window as any).__jobEvents = []
    ;(window as any).api.on('media:job_started', (p: unknown) => {
      ;(window as any).__jobEvents.push(['started', p])
    })
    ;(window as any).api.on('media:job_complete', (p: unknown) => {
      ;(window as any).__jobEvents.push(['complete', p])
    })
  })

  // invoke import_media — the dispatcher expects { path: string }
  const mediaId = await page.evaluate(
    (f) => (window as any).api.invoke('import_media', { path: f }),
    FIXTURE,
  )
  expect(typeof mediaId).toBe('string')
  expect((mediaId as string).length).toBeGreaterThan(0)

  // project_summary.media is Vec<MediaSummary> where each entry has .id
  const summary = await page.evaluate(() => (window as any).api.invoke('project_summary', {}))
  const ids: string[] = ((summary as any).media ?? []).map((m: any) => m.id)
  expect(ids).toContain(mediaId as string)

  await app.close()
})
