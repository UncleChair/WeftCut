import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dockPanel, launchApp, newProject, tmpDir } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Prefer WEFTCUT_TEST_MEDIA from env; fall back to the bundled fixture so the
// gate runs in CI without a side-channel media directory.
const FALLBACK = path.resolve(__dirname, '../../e2e/fixtures/media/test_1080p_30fps.mp4')
const MEDIA_PATH = process.env['WEFTCUT_TEST_MEDIA'] ?? FALLBACK

const mediaCount = async (page: Page): Promise<number> => {
  const s = await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))
  return ((s as any).media ?? []).length
}

// Direct-pipeline contract: the main `media:dropped` handler re-emits
// `evt:media:external-drop` and the renderer imports it. Stable (no CDP); guards
// the downstream half regardless of how the OS delivers the drop.
test('media:dropped imports the file via the external-drop pipeline', async () => {
  test.skip(!fs.existsSync(MEDIA_PATH), `media fixture missing: ${MEDIA_PATH}`)
  test.setTimeout(60_000)

  const PROJECT_PARENT = tmpDir('weftcut-e2e-dragdrop-proj-')

  const { app, page } = await launchApp()
  try {
    // Enter the editor so the media:external-drop listener is mounted.
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-drag-direct-' + Date.now(),
      canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 },
    })

    // Confirm the preload media bridge is wired before exercising the channel.
    await page.waitForFunction(() => typeof (window as any).api?.media?.dropped === 'function')

    const before = await mediaCount(page)
    await page.evaluate((p) => (window as any).api.media.dropped([p]), MEDIA_PATH)

    // Import is async (probe + MediaItem insert in a blocking task, then the actor
    // processes it). Poll project_summary until the media count grows.
    await expect
      .poll(() => mediaCount(page), { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(before)
  } finally {
    await app.close()
  }
})

// Real DOM drop: synthesize an OS-style file drop onto the media pool via CDP
// (`Input.dispatchDragEvent` with `data.files` → Blink builds disk-backed File
// objects), exercising the FULL chain the production drop uses — the preload
// `wireFileDrop` window listener → `webUtils.getPathForFile` (native-backed, so it
// resolves; across the contextBridge it would return '' — electron#44600) →
// `media:dropped` → import.
//
// NOTE: this does NOT reproduce the UIPI / elevated-launch failure mode (drag
// blocked when the app runs at higher integrity than Explorer) — that is a
// cross-process OS condition, not an in-process synthesized drag. This guards the
// code chain against regressions; the OS-integrity case is environmental.
test('a real DOM file-drop on the media pool imports via wireFileDrop', async () => {
  test.skip(!fs.existsSync(MEDIA_PATH), `media fixture missing: ${MEDIA_PATH}`)
  test.setTimeout(60_000)

  const PROJECT_PARENT = tmpDir('weftcut-e2e-dragdrop-proj-')

  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-drag-dom-' + Date.now(),
      canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 },
    })

    // The launch splash is a full-window overlay (data-drag-region) that owns a
    // ~2.5 s intro before it exits and unmounts. Playwright's locator actions
    // auto-wait for actionability, but Input.dispatchDragEvent below is a raw
    // coordinate dispatch with NO such retry — fired during the intro it lands on
    // the splash, not the media pool, and the preload's closest('.media-pool')
    // guard then discards the drop. Wait the splash out before dropping.
    await page.locator('.splash-screen').waitFor({ state: 'detached', timeout: 15_000 })

    // The drop targets the media pool; resolve its viewport-center coordinates.
    await page.waitForSelector('.media-pool')
    const box = await page.locator('.media-pool').boundingBox()
    if (!box) throw new Error('media pool has no bounding box')
    const x = Math.round(box.x + box.width / 2)
    const y = Math.round(box.y + box.height / 2)

    const before = await mediaCount(page)

    // Drive a file drop over Playwright's own CDP connection (no
    // webContents.debugger attach conflict). `files` carries real disk paths so
    // the dropped File objects are native-backed for webUtils.getPathForFile.
    const client = await app.context().newCDPSession(page)
    const data = { items: [], files: [MEDIA_PATH], dragOperationsMask: 1 }
    await client.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
    await client.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
    await client.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })

    await expect
      .poll(() => mediaCount(page), { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(before)

    // A Files payload belongs exclusively to Media import; Dockview must not
    // create, close, or duplicate any Panel while its overlay is suppressed.
    const panelKinds = await dockPanel(page).evaluateAll((panels) =>
      panels.map((panel) => panel.getAttribute('data-panel-kind')).sort(),
    )
    expect(panelKinds).toEqual([
      'attribute',
      'effect',
      'media',
      'nearby',
      'preview',
      'quick-actions',
      'timeline',
    ])
  } finally {
    await app.close()
  }
})
