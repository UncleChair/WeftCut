import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  importAndPlaceMedia,
  invokeCmd,
  launchApp,
  newProject,
  tmpDir,
  waitForHook,
} from './helpers/driver'

type Layer = {
  id: string
  t_start_us: number
  t_end_us: number
  params: { kind: string }
}

type Summary = {
  tracks: Array<{
    layers: Layer[]
  }>
}

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/media/test_1080p_30fps.mp4',
)

const videoLayers = (summary: Summary): Layer[] =>
  summary.tracks
    .flatMap((track) => track.layers)
    .filter((layer) => layer.params.kind === 'VideoClip')

const readSummary = (page: Page): Promise<Summary> =>
  invokeCmd<Summary>(page, 'project_summary')

test('an older summary cannot restore a VideoClip after split-right-delete', async () => {
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-split-delete-race-'),
      name: `split-delete-${Date.now()}`,
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
    })

    const imported = await importAndPlaceMedia(page, { mediaAbsPath: fixture })
    expect(imported.kind).toBe('Video')
    await waitForHook(page, 'revealLayer')
    await page.evaluate(
      (layerId) => (window as any).__weftcutTest.revealLayer({ layerId }),
      imported.layerId,
    )

    const blocks = page.locator('.timeline-layer[title^="VideoClip:"]')
    await expect(blocks).toHaveCount(1)
    const originalBox = await blocks.first().boundingBox()
    expect(originalBox).not.toBeNull()
    const original = videoLayers(await readSummary(page))[0]!
    const originalDurationUs = original.t_end_us - original.t_start_us

    // Capture two pre-split snapshots (App summary + project-store mirror) and
    // hold their delivery. A label commit stands in for any prior project
    // change whose refresh overlaps the user's following split/delete.
    await page.evaluate(() => {
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const gate = {
        remaining: 2,
        captured: 0,
        delivered: 0,
        release,
        released,
      }
      ;(globalThis as any).__weftcutSummaryRaceGate = gate
      ;(globalThis as any).__weftcutE2EBackendInvokeInterceptor = async (
        cmd: string,
        args: Record<string, unknown> | undefined,
        next: (
          cmd: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>,
      ) => {
        if (cmd !== 'project_summary' || gate.remaining === 0) {
          return next(cmd, args)
        }
        gate.remaining -= 1
        const snapshot = await next(cmd, args)
        gate.captured += 1
        await gate.released
        gate.delivered += 1
        return snapshot
      }
    })
    await invokeCmd(page, 'update_layer', {
      layerId: imported.layerId,
      patch: { label: 'summary-race-probe' },
    })
    await page.waitForFunction(
      () => (globalThis as any).__weftcutSummaryRaceGate?.captured === 2,
    )

    await page.keyboard.press('c')
    await expect(page.locator('.timeline-root-blade')).toHaveCount(1)
    await blocks.first().click({
      position: {
        x: originalBox!.width / 2,
        y: originalBox!.height / 2,
      },
    })
    await expect(blocks).toHaveCount(2)
    await page.keyboard.press('c')
    await expect(page.locator('.timeline-root-blade')).toHaveCount(0)

    const rightIndex = await blocks.evaluateAll((nodes) => {
      const boxes = nodes.map((node, index) => ({
        index,
        x: node.getBoundingClientRect().x,
      }))
      boxes.sort((a, b) => a.x - b.x)
      return boxes.at(-1)!.index
    })
    await blocks.nth(rightIndex).click()
    await page.keyboard.press('Delete')

    await expect
      .poll(async () => videoLayers(await readSummary(page)).length)
      .toBe(1)
    await expect(blocks).toHaveCount(1)
    const cutLayer = videoLayers(await readSummary(page))[0]!
    expect(cutLayer.id).toBe(imported.layerId)
    expect(cutLayer.t_end_us - cutLayer.t_start_us).toBeCloseTo(
      originalDurationUs / 2,
      -4,
    )
    await expect
      .poll(async () => {
        const box = await blocks.first().boundingBox()
        return box!.width / originalBox!.width
      })
      .toBeLessThan(0.65)

    // Now let the older pre-split summaries arrive. They must be ignored.
    await page.evaluate(() => {
      ;(globalThis as any).__weftcutSummaryRaceGate.release()
    })
    await page.waitForFunction(
      () => (globalThis as any).__weftcutSummaryRaceGate?.delivered === 2,
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )

    const backendAfterRelease = videoLayers(await readSummary(page))[0]!
    const renderedAfterRelease = await blocks.first().boundingBox()
    expect(backendAfterRelease.t_end_us - backendAfterRelease.t_start_us).toBeCloseTo(
      originalDurationUs / 2,
      -4,
    )
    expect(renderedAfterRelease!.width / originalBox!.width).toBeLessThan(0.65)
  } finally {
    await page
      .evaluate(() => {
        delete (globalThis as any).__weftcutE2EBackendInvokeInterceptor
        delete (globalThis as any).__weftcutSummaryRaceGate
      })
      .catch(() => {})
    await app.close()
  }
})
