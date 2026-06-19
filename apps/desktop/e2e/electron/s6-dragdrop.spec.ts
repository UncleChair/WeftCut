import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Prefer WEFTCUT_TEST_MEDIA from env; fall back to the bundled fixture so the
// gate runs in CI without a side-channel media directory.
const FALLBACK = path.resolve(__dirname, '../../e2e/fixtures/media/test_1080p_30fps.mp4')
const MEDIA_PATH = process.env['WEFTCUT_TEST_MEDIA'] ?? FALLBACK

const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-s6-dragdrop-proj')

test('a media file dropped on the pool imports via media:external-drop', async () => {
  test.skip(!fs.existsSync(MEDIA_PATH), `media fixture missing: ${MEDIA_PATH}`)
  test.setTimeout(60_000)

  fs.mkdirSync(PROJECT_PARENT, { recursive: true })

  const { app, page } = await launchApp()
  try {
    // Enter the editor so the media:external-drop listener is mounted.
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-s6-drag-' + Date.now(),
      canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 },
    })

    // Confirm the preload shim is wired before exercising the channel.
    await page.waitForFunction(() => typeof (window as any).api?.getPathForFile === 'function')

    // Snapshot media pool size before the drop.
    const before = await page.evaluate(() => (window as any).api.invoke('project_summary', {}))
    const beforeCount: number = ((before as any).media ?? []).length

    // Simulate the resolved-path leg of the Electron drop branch directly:
    // the renderer's media:external-drop listener imports the file.
    await page.evaluate((p) => (window as any).api.invoke('media:dropped', [p]), MEDIA_PATH)

    // Poll project_summary until media count grows (import is async: probe +
    // MediaItem insert happens in a blocking task then the actor processes it).
    // Use Playwright's poll helper rather than an async waitForFunction predicate
    // to avoid the async-truthy-promise gotcha.
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(() => (window as any).api.invoke('project_summary', {}))
          return ((s as any).media ?? []).length
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThan(beforeCount)
  } finally {
    await app.close()
  }
})
