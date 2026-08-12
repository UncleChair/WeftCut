import { test, expect, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importAndPlaceMedia, invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// A still image is ready the moment it is imported — no proxy job, so nothing
// background-dispatches while the drag is in flight and `history.len` counts only
// what this spec asked for.
const FIXTURE = path.resolve(__dirname, '../fixtures/media/test_chart_320x240.png')

interface RaiseSummary {
  history: { len: number }
  tracks: Array<{ id: string; role: string | null; layers: Array<{ id: string }> }>
}

const raiseSummary = (page: Page) => invokeCmd<RaiseSummary>(page, 'project_summary', {})

const laneHolding = (s: RaiseSummary, layerId: string): string | null =>
  s.tracks.find((t) => t.layers.some((l) => l.id === layerId))?.id ?? null

test.describe('timeline drop strip — an existing clip', () => {
  test.skip(
    !existsSync(FIXTURE),
    `image fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  )

  // The companion to `timeline-drop-strip.spec.ts`: one spec per event model,
  // because two of them converge on this one row and a pure-function test passes
  // either way. This is the POINTER-driven half — it never touches the HTML5
  // drag-and-drop handlers, terminating instead in the timeline's own drag-commit
  // path — and it exists mainly for its last two assertions. Whether the source
  // lane really disappears is the defect's own signature (a no-op prune passed
  // every unit test in this repo for as long as it existed), and whether the
  // gesture stayed ONE history entry is the cheapest guard against it quietly
  // decomposing back into add-track-then-move.
  test('dragged onto the strip spawns a lane, moves the clip, and removes the lane it left', async () => {
    test.setTimeout(90_000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-raise-strip-'),
        name: 'e2e-raise-strip-' + Date.now(),
        canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
      })

      // Places the clip on a lane of its own, which is what makes "the lane it
      // left" observable: the raise empties that lane, and an emptied role-less
      // lane is exactly what the cleanup rule removes.
      const { layerId } = await importAndPlaceMedia(page, { mediaAbsPath: FIXTURE })
      // That lane carries no role, so A/B-roll mode — the default — filters it out
      // and its clip never mounts. The reveal also selects the clip, which is why
      // the drag below needs no separate arming click.
      await waitForHook(page, 'revealLayer')
      await page.evaluate(
        (id) => (window as any).__weftcutTest.revealLayer({ layerId: id }),
        layerId,
      )
      const clip = page.locator('.timeline-layer').first()
      await expect(clip).toBeVisible({ timeout: 20_000 })
      // REQUIRED before any pointer gesture: the launch splash is a full-window
      // overlay that outlives the first timeline render, so every mouse event
      // below would land on it instead of the clip.
      await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

      const before = await raiseSummary(page)
      const sourceLaneId = laneHolding(before, layerId)
      expect(sourceLaneId).not.toBeNull()
      const laneIdsBefore = new Set(before.tracks.map((t) => t.id))

      const strip = page.locator('[data-testid="timeline-drop-strip"]')
      await expect(strip).toBeVisible()
      const stripBox = await strip.boundingBox()
      const clipBox = await clip.boundingBox()
      if (!stripBox || !clipBox) throw new Error('strip or clip has no layout box')

      // Real mouse input, one protocol round trip per step. Firing the three
      // events in one page task would leave React uncommitted between them, so
      // the drag the pointerdown began would not exist yet when the move arrived.
      const dragX = clipBox.x + clipBox.width / 2
      await page.mouse.move(dragX, clipBox.y + clipBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(dragX, stripBox.y + stripBox.height / 2)

      // The intermediate state, asserted with the button still down: the strip
      // lights from a drag that publishes to no media-drag store, which is the
      // half of the wiring a unit test on the placement policy cannot see.
      await expect(strip).toHaveAttribute('data-lit', 'true')
      await expect(page.locator('[data-testid="timeline-drop-strip-hint"]')).toBeVisible()

      await page.mouse.up()

      // The whole point, in three clauses: a lane that did not exist now holds the
      // clip, the lane it left is gone BY ID, and the cost was one history entry.
      await expect
        .poll(
          async () => laneHolding(await raiseSummary(page), layerId),
          { timeout: 20_000, intervals: [250, 500, 1000] },
        )
        .not.toBe(sourceLaneId)

      const after = await raiseSummary(page)
      const spawnedLaneId = laneHolding(after, layerId)
      expect(laneIdsBefore.has(spawnedLaneId!)).toBe(false)
      expect(after.tracks.map((t) => t.id)).not.toContain(sourceLaneId)
      // Spawned, so role-less, and appended — the tail of the vector is the top of
      // the z-stack, which is the only spawn point (ADR 0042).
      expect(after.tracks.find((t) => t.id === spawnedLaneId)!.role).toBeNull()
      expect(after.tracks.at(-1)!.id).toBe(spawnedLaneId)
      // Nothing else moved, and no second lane was minted on the way.
      expect(after.tracks.flatMap((t) => t.layers).map((l) => l.id)).toEqual([layerId])
      expect(after.history.len).toBe(before.history.len + 1)
    } finally {
      await app.close()
    }
  })
})
