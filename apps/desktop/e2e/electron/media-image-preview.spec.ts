import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../fixtures/media/test_chart_320x240.png')

test.describe('still image media preview', () => {
  test.skip(!existsSync(FIXTURE), `image fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`)

  test('shows an imported image thumbnail and composites it in the live preview', async () => {
    const { app, page } = await launchApp()
    try {
      const PROJECT_PARENT = tmpDir('weftcut-e2e-image-preview-')
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-image-preview-' + Date.now(),
        canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
      })

      const placed = await importAndPlaceMedia(page, { mediaAbsPath: FIXTURE, tStartUs: 0 })
      expect(placed.kind).toBe('Image')

      const summary = await invokeCmd<{
        tracks: Array<{ layers: Array<{ id: string; params: { kind: string } }> }>
      }>(page, 'project_summary', {})
      const layer = summary.tracks.flatMap((t) => t.layers).find((l) => l.id === placed.layerId)
      expect(layer?.params.kind).toBe('ImageOverlay')

      const thumb = page.locator('.media-item-thumb img.media-thumbnail')
      await expect(thumb).toBeVisible()
      await expect(thumb).toHaveAttribute('src', /^weftcut-media:\/\//)

      let sample: { r: number; g: number; b: number; a: number; nonTransparent: number; maxA: number } | null = null
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const maybeSample = await page.evaluate(async () => {
          try {
            const hook = (window as any).__weftcutTest
            hook.weftcutSeekUs(0)
            const sample = await hook.weftcutSampleComposite(20, 20)
            if (sample.nonTransparent <= 0 || sample.maxA !== 255) return null
            return sample
          } catch {
            return null
          }
        }) as typeof sample
        if (maybeSample) {
          sample = maybeSample
          break
        }
        await page.waitForTimeout(250)
      }
      expect(sample).toMatchObject({ r: 255, g: 0, b: 0, a: 255 })
    } finally {
      await app.close()
    }
  })
})
