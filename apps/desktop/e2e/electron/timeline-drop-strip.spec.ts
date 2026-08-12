import { test, expect, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// A still image is ready the moment it is in the pool — no proxy, so the card is
// draggable without waiting on a background job, and its layer kind
// (ImageOverlay) identifies the placement unambiguously.
const FIXTURE = path.resolve(__dirname, '../fixtures/media/test_chart_320x240.png')

interface StripSummary {
  tracks: Array<{
    id: string
    role: string | null
    layers: Array<{ id: string; params: { kind: string; media_id?: string } }>
  }>
  media: Array<{ id: string }>
}

const stripSummary = (page: Page) => invokeCmd<StripSummary>(page, 'project_summary', {})

/// Drive the media pool → timeline HTML5 drag the way the app's own handlers see
/// it. Not `locator.dragTo`: the two ends live in different dock panels, and the
/// card's payload exists only because its `dragstart` handler ran — so the
/// gesture has to keep ONE DataTransfer alive across all three events, parked on
/// `window` between them.
///
/// Each event is its own `page.evaluate` on purpose. Fired back to back in one
/// task, React has not committed the drag the card just began, so the strip's
/// `dragover` still sees no active drag and never claims the highlight. A real
/// drag delivers these as separate tasks.
const beginMediaCardDrag = (page: Page, mediaId: string) =>
  page.evaluate((id) => {
    const card = document.querySelector(`.media-item[data-media-id="${id}"]`)
    if (!card) throw new Error(`media card ${id} missing from the DOM`)
    const rect = card.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    ;(window as any).__stripDragTransfer = dataTransfer
    card.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    )
  }, mediaId)

const fireOnDropStrip = (page: Page, type: 'dragover' | 'drop', clientX: number) =>
  page.evaluate(
    ({ t, x }) => {
      const strip = document.querySelector('[data-testid="timeline-drop-strip"]')
      if (!strip) throw new Error('drop strip missing from the DOM')
      const rect = strip.getBoundingClientRect()
      strip.dispatchEvent(
        new DragEvent(t, {
          bubbles: true,
          cancelable: true,
          dataTransfer: (window as any).__stripDragTransfer,
          clientX: x,
          clientY: rect.y + rect.height / 2,
        }),
      )
    },
    { t: type, x: clientX },
  )

test.describe('timeline drop strip', () => {
  test.skip(
    !existsSync(FIXTURE),
    `image fixture not found at ${FIXTURE} (run: cd apps/desktop/e2e && npm run fixtures)`,
  )

  // Two event models converge on this one target (HTML5 drag-and-drop here,
  // pointer-driven for an existing clip), which is exactly where a pure-function
  // test passes while the wiring is wrong — hence a gate against the real app.
  test('a media-pool drop on the strip spawns a lane and places the clip on it', async () => {
    test.setTimeout(90_000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-drop-strip-'),
        name: 'e2e-drop-strip-' + Date.now(),
        canvas: { width: 640, height: 480, fpsNum: 30, fpsDen: 1 },
      })

      // Import into the pool WITHOUT placing, so the drag is the only thing that
      // can put a layer on the timeline.
      await page.waitForFunction(() => typeof (window as any).api?.media?.dropped === 'function')
      await page.evaluate((p) => (window as any).api.media.dropped([p]), FIXTURE)
      await expect
        .poll(async () => (await stripSummary(page)).media.length, { timeout: 30_000 })
        .toBe(1)
      const mediaId = (await stripSummary(page)).media[0]!.id

      // `draggable` is the pool's own readiness gate: waiting on it keeps this a
      // gesture a user could actually perform.
      const card = page.locator(`.media-item[data-media-id="${mediaId}"][draggable="true"]`)
      await expect(card).toBeVisible({ timeout: 30_000 })

      const strip = page.locator('[data-testid="timeline-drop-strip"]')
      await expect(strip).toBeVisible()
      const stripBox = await strip.boundingBox()
      if (!stripBox) throw new Error('drop strip has no layout box')

      const before = await stripSummary(page)
      const trackIdsBefore = new Set(before.tracks.map((t) => t.id))
      expect(before.tracks.flatMap((t) => t.layers)).toHaveLength(0)
      const lanes = page.locator('[data-testid="track-lane"]')
      await expect(lanes).toHaveCount(2) // the reserved A/B skeleton

      // 32px in from the strip's left edge is the cursor-in-ghost offset, so the
      // clip lands at t=0 — well clear of the sticky header column.
      const dropX = stripBox.x + 32
      await beginMediaCardDrag(page, mediaId)
      await fireOnDropStrip(page, 'dragover', dropX)

      // Hovering lights the strip and says what release will do. `spawn` on the
      // ghost is the fourth placement outcome reaching the UI.
      await expect(strip).toHaveAttribute('data-lit', 'true')
      await expect(page.locator('[data-testid="timeline-drop-strip-ghost"]')).toHaveAttribute(
        'data-validity',
        'spawn',
      )
      await expect(page.locator('[data-testid="timeline-drop-strip-hint"]')).toBeVisible()

      await fireOnDropStrip(page, 'drop', dropX)

      // Assert observable state: a lane that did not exist before now carries the
      // dropped clip. The lane is role-less (spawned, not part of the skeleton)
      // and sits at the tail of the track vector — the top of the z-stack.
      await expect
        .poll(
          async () => {
            const after = await stripSummary(page)
            const fresh = after.tracks.filter((t) => !trackIdsBefore.has(t.id))
            return fresh.length === 1 ? fresh[0]!.layers.length : -1
          },
          { timeout: 20_000, intervals: [250, 500, 1000] },
        )
        .toBe(1)

      const after = await stripSummary(page)
      const fresh = after.tracks.filter((t) => !trackIdsBefore.has(t.id))
      expect(fresh[0]!.role).toBeNull()
      expect(after.tracks.at(-1)!.id).toBe(fresh[0]!.id)
      const placed = fresh[0]!.layers[0]!
      expect(placed.params.kind).toBe('ImageOverlay')
      expect(placed.params.media_id).toBe(mediaId)
      // Nothing landed anywhere else: spawning is the drop, not a side effect.
      expect(after.tracks.flatMap((t) => t.layers)).toHaveLength(1)
      // The spawned lane carries no role, so A/B mode — the default — would
      // filter it out and hide the clip the user just dropped. The inline reveal
      // is what keeps the result on screen.
      await expect(lanes).toHaveCount(3)
    } finally {
      await app.close()
    }
  })
})
