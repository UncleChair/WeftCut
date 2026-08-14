import { test, expect, type Page } from '@playwright/test'

import { dockPanel, dockTab, invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'

/**
 * Nearby z-order restack in the real app (ADR 0044, nearby-z-order ticket 06).
 *
 * Both tests below exist for what the colocated Vitest suites cannot see: the
 * grip drag is pure pointer events fired inside a live Dockview panel, so only
 * a real Electron run can prove the gesture stays a row-reorder instead of
 * being captured as a panel dock drag — and that the drop's ONE anchored
 * `restack_layer` really reorders the project's track vector (z = track
 * order, tail on top) and costs exactly one history entry, which one
 * `project_undo` restores.
 *
 * No media fixtures: three overlapping Color layers build the At-playhead
 * stack. Each `add_color_layer` over an occupied interval spawns its own
 * role-less Overlay lane, which is exactly the hidden-in-A/B-Roll population
 * the Nearby panel surfaces.
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

interface StackSummary {
  history: { len: number }
  tracks: Array<{ id: string; role: string | null; layers: Array<{ id: string }> }>
}

const stackSummary = (page: Page) => invokeCmd<StackSummary>(page, 'project_summary', {})

/// The overlay stack as the PROJECT holds it: layer ids on role-less lanes in
/// track-vector order, bottom-of-z first. The real-stacking assertions read
/// this — not the panel's rows — so a restack that only rearranged the DOM
/// could never pass.
const overlayLayerOrder = (s: StackSummary): string[] =>
  s.tracks.filter((t) => t.role === null).flatMap((t) => t.layers.map((l) => l.id))

/// The lane holding `layerId`, by id — for asserting the sole-occupant restack
/// path moved the lane WHOLE (identity survives) instead of minting a new one.
const laneOf = (s: StackSummary, layerId: string): string | null =>
  s.tracks.find((t) => t.layers.some((l) => l.id === layerId))?.id ?? null

/// Three Color layers over the same 0–4 s interval, playhead at 0 → all three
/// span the playhead and each occupies its own role-less Overlay lane
/// (appended, so added-last composites on top). Labelled via the recorded
/// rename command so rows and grips are addressable by name instead of brittle
/// positions. Returns ids bottom-of-z first: [under, mid, over].
async function threeOverlappingOverlays(
  page: Page,
): Promise<{ under: string; mid: string; over: string }> {
  const add = () =>
    invokeCmd<string>(page, 'add_color_layer', { tStartUs: 0, durationUs: 4_000_000 })
  const under = await add()
  const mid = await add()
  const over = await add()
  const rename = (layerId: string, label: string) =>
    invokeCmd(page, 'update_layer', { layerId, patch: { label } })
  await rename(under, 'Under')
  await rename(mid, 'Mid')
  await rename(over, 'Over')

  // The setup's own contract, checked before anything rides on it: three
  // distinct role-less lanes in add order.
  expect(overlayLayerOrder(await stackSummary(page))).toEqual([under, mid, over])
  return { under, mid, over }
}

/// The At-playhead section (a named <section> → ARIA region) and its rows,
/// top-of-stack first — the panel's own presentation order.
const atPlayheadStack = (page: Page) => page.getByRole('region', { name: 'At playhead' })
const stackRows = (page: Page) => atPlayheadStack(page).locator('.right-panel-peek-list > li')
const rowLabels = (page: Page) => stackRows(page).locator('.peek-label').allTextContents()

/// Boot into a project with the Nearby panel ACTIVE. It ships inactive in the
/// default layout (tabbed behind Attribute), so the spec clicks its tab — the
/// splash overlay must be gone first or the click lands on it.
async function openNearbyOverStack(page: Page): Promise<void> {
  await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })
  await dockTab(page, 'nearby').click()
  await expect(dockPanel(page, 'nearby')).toHaveAttribute('data-panel-visible', 'true')
  // Rows arrive with the next summary render; top-of-stack first.
  await expect.poll(() => rowLabels(page), { timeout: 15_000 }).toEqual(['Over', 'Mid', 'Under'])
}

test('a Nearby grip drag restacks the real project and one undo restores it', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-nearby-restack-'),
      name: 'e2e-nearby-restack-' + Date.now(),
      canvas: CANVAS,
    })
    const { under, mid, over } = await threeOverlappingOverlays(page)
    await openNearbyOverStack(page)

    const before = await stackSummary(page)

    // ── Drag the top row's grip to the section bottom ─────────────────────
    // Real mouse input, one protocol round trip per step (the gesture's window
    // listeners must observe committed React state between events). The drop
    // point sits past the bottom row's midline, so the gap hit-test resolves
    // the section-bottom slot: anchor = bottom row (Under), position below.
    const grip = page.getByLabel('Drag to restack Over')
    await expect(stackRows(page)).toHaveCount(3)
    const gripBox = await grip.boundingBox()
    const bottomRowBox = await stackRows(page).nth(2).boundingBox()
    if (!gripBox || !bottomRowBox) throw new Error('grip or bottom row has no layout box')
    const x = gripBox.x + gripBox.width / 2
    await page.mouse.move(x, gripBox.y + gripBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, bottomRowBox.y + bottomRowBox.height - 3, { steps: 12 })

    // Mid-gesture, button still down: the PANEL owns the pointer — reorder
    // styling armed and the insertion indicator on the section-bottom gap. If
    // Dockview had captured the gesture as a panel drag, neither appears.
    await expect(atPlayheadStack(page)).toHaveClass(/peek-stack--reordering/)
    await expect(stackRows(page).nth(2)).toHaveClass(/peek-row--drop-after/)

    await page.mouse.up()

    // Real stacking changed, from project state: Over now sits at the bottom
    // of the overlay stack (track-vector order, bottom first).
    await expect
      .poll(async () => overlayLayerOrder(await stackSummary(page)), {
        timeout: 20_000,
        intervals: [250, 500, 1000],
      })
      .toEqual([over, under, mid])

    const after = await stackSummary(page)
    // ONE anchored op per completed drag — the gesture must not decompose into
    // a track-add + move pair.
    expect(after.history.len).toBe(before.history.len + 1)
    // Sole-occupant path: the mover's LANE moved whole, identity intact, and
    // nothing was minted or pruned along the way.
    expect(laneOf(after, over)).toBe(laneOf(before, over))
    expect(after.tracks.map((t) => t.id).sort()).toEqual(before.tracks.map((t) => t.id).sort())
    // The panel re-renders to the new z order, top-of-stack first.
    await expect.poll(() => rowLabels(page)).toEqual(['Mid', 'Under', 'Over'])

    // ── One undo restores the whole restack ───────────────────────────────
    await invokeCmd(page, 'project_undo', {})
    await expect
      .poll(async () => overlayLayerOrder(await stackSummary(page)), {
        timeout: 20_000,
        intervals: [250, 500, 1000],
      })
      .toEqual([under, mid, over])
    await expect.poll(() => rowLabels(page)).toEqual(['Over', 'Mid', 'Under'])
  } finally {
    await app.close()
  }
})

test('the row context menu Bring-to-front restacks and one undo restores it', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-nearby-menu-'),
      name: 'e2e-nearby-menu-' + Date.now(),
      canvas: CANVAS,
    })
    const { under, mid, over } = await threeOverlappingOverlays(page)
    await openNearbyOverStack(page)

    const before = await stackSummary(page)

    // Right-click the BOTTOM row — with three rows, Bring to front is the one
    // menu action a single-step drag can't mimic (it jumps over Mid).
    await page.getByTitle('Under', { exact: true }).click({ button: 'right' })
    // The popup is named for the row it orders, so a menu opened on the wrong
    // row fails here rather than restacking the wrong layer.
    await expect(page.getByRole('menu', { name: 'Restack Under' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Bring to front' }).click()

    // Under jumped the whole stack: bottom-first order [mid, over, under].
    await expect
      .poll(async () => overlayLayerOrder(await stackSummary(page)), {
        timeout: 20_000,
        intervals: [250, 500, 1000],
      })
      .toEqual([mid, over, under])

    const after = await stackSummary(page)
    // One item click = one restack = one history entry (ADR 0044 decision 4).
    expect(after.history.len).toBe(before.history.len + 1)
    await expect.poll(() => rowLabels(page)).toEqual(['Under', 'Over', 'Mid'])

    await invokeCmd(page, 'project_undo', {})
    await expect
      .poll(async () => overlayLayerOrder(await stackSummary(page)), {
        timeout: 20_000,
        intervals: [250, 500, 1000],
      })
      .toEqual([under, mid, over])
    await expect.poll(() => rowLabels(page)).toEqual(['Over', 'Mid', 'Under'])
  } finally {
    await app.close()
  }
})
