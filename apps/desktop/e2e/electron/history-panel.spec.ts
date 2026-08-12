import { expect, test, type Page } from '@playwright/test'

import { dockPanel, invokeCmd, launchApp, newProject, summary, tmpDir } from './helpers/driver'

/**
 * The History Panel end to end: open it from the View menu, navigate the edit
 * stack by clicking a row, and run the checkpoint section's whole create →
 * restore → delete loop.
 *
 * Everything here is unreachable from the colocated Vitest tests, which mock
 * the IPC surface: the assertions below are about the REAL round trip —
 * `project_jump_to` actually reverting the timeline, the post-jump
 * `project:changed` refetch actually landing before the linkage resolves, and
 * `create_checkpoint` / `delete_checkpoint` NOT broadcasting (so the Panel's
 * own explicit refetch is the only reason the list is ever right).
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

/// Every layer id currently on the timeline, in track order. The state-reverted
/// assertions read this rather than counting DOM blocks: a hidden A/B-roll
/// track renders no LayerBlock at all, which would read as "reverted" for the
/// wrong reason.
async function layerIds(page: Page): Promise<string[]> {
  const s = await summary(page)
  return s.tracks.flatMap((track) => track.layers.map((layer) => layer.id))
}

const entryRows = (page: Page) => page.locator('.history-entry-row')
/// The redo tail. Greyed but still clickable; a new edit truncates it silently.
const futureRows = (page: Page) => page.locator('.history-row[data-state="future"]')
const checkpointRows = (page: Page) => page.locator('.history-checkpoint-row')

/// Absolute stack index of the row holding the cursor — the `jumpTo` target a
/// later step clicks. Read rather than computed: `add_color_layer` commits a
/// second entry (the Overlay track) whenever no free track exists, so index
/// arithmetic over "one edit = one row" is wrong exactly when it matters.
async function cursorIndex(page: Page): Promise<number> {
  const row = page.locator('.history-entry-row[aria-current="true"]')
  await expect(row).toHaveCount(1)
  return Number(await row.getAttribute('data-history-index'))
}

const playheadUs = (page: Page) =>
  page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs() as number)
const selectedLayerId = (page: Page) =>
  page.evaluate(() => (window as any).__weftcutTest.getSelectedLayerId() as string | null)

test('History Panel navigates the edit stack and runs the checkpoint loop', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    const parent = tmpDir('weftcut-history-')
    await newProject(page, { parentFolder: parent, name: 'history-panel', canvas: CANVAS })
    // REQUIRED before any pointer gesture: the splash overlay outlives the
    // first dock render and swallows mousedown while the target is visible.
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

    // ── Open the Panel from the View menu ─────────────────────────────────
    // No View-menu code was written for it: `ViewMenu` maps over PANEL_KINDS,
    // so registering the Panel put it there. This is the check on that.
    await expect(dockPanel(page, 'history')).toHaveCount(0)
    const viewMenu = page.locator('.menu-trigger').nth(2)
    await viewMenu.click()
    await page.locator('.app-menu-item').filter({ hasText: /^History$/ }).click()
    await expect(dockPanel(page, 'history')).toHaveCount(1)
    // The section states the session-only lifetime unprompted — a user who
    // reads checkpoints as durable saves loses work.
    await expect(page.locator('.history-checkpoints .checkpoint-session-note')).toHaveText(
      /This session only/,
    )

    // ── Three edits ───────────────────────────────────────────────────────
    const a = await invokeCmd<string>(page, 'add_color_layer', {
      tStartUs: 0,
      durationUs: 1_000_000,
    })
    await expect.poll(() => entryRows(page).count()).toBeGreaterThan(1)
    const indexAfterA = await cursorIndex(page)

    const b = await invokeCmd<string>(page, 'add_color_layer', {
      tStartUs: 1_000_000,
      durationUs: 1_000_000,
    })
    await expect.poll(() => cursorIndex(page)).toBeGreaterThan(indexAfterA)

    const c = await invokeCmd<string>(page, 'add_color_layer', {
      tStartUs: 2_000_000,
      durationUs: 1_000_000,
    })
    await expect.poll(async () => (await layerIds(page)).length).toBe(3)
    const indexAfterC = await cursorIndex(page)
    expect(indexAfterC).toBeGreaterThan(indexAfterA)

    // Park the playhead somewhere non-zero. Without this the "playhead did not
    // move" assertion is vacuous: layer A starts at 0, so a linkage that DID
    // seek would land on the value the test expects.
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(() => playheadUs(page)).toBe(2_000_000)

    // ── Click an earlier row → jump ───────────────────────────────────────
    await page.locator(`.history-entry-row[data-history-index="${indexAfterA}"]`).click()

    // The timeline state reverted: B and C are gone, A is back on its own.
    await expect.poll(() => layerIds(page)).toEqual([a])
    // …the affected clip is selected (the entry the cursor LANDED on names it)…
    await expect.poll(() => selectedLayerId(page)).toBe(a)
    // …and the playhead did not move. A history jump changes what is ON the
    // timeline, not which frame is being looked at — that is what makes
    // "same frame, before and after" comparison possible (spec decision 8).
    expect(await playheadUs(page)).toBe(2_000_000)

    // The rows past the cursor are the greyed redo tail, still clickable.
    await expect(futureRows(page)).toHaveCount(indexAfterC - indexAfterA)
    await expect(page.locator('.history-entry-row[aria-current="true"]')).toHaveAttribute(
      'data-history-index',
      String(indexAfterA),
    )

    // ── A new edit truncates the tail, silently ───────────────────────────
    const d = await invokeCmd<string>(page, 'add_color_layer', {
      tStartUs: 1_000_000,
      durationUs: 1_000_000,
    })
    await expect.poll(() => layerIds(page)).toEqual([a, d])
    // No dialog, no confirmation — the grey WAS the warning (spec decision 6).
    await expect(futureRows(page)).toHaveCount(0)
    await expect(entryRows(page)).toHaveCount(indexAfterA + 2)
    expect(b).not.toBe(d)
    expect(c).not.toBe(d)

    // ── Checkpoint: create ────────────────────────────────────────────────
    await expect(page.locator('.history-checkpoints-empty')).toBeVisible()
    await page.locator('.history-checkpoints button', { hasText: 'New' }).click()
    await page.getByLabel('Checkpoint name').fill('before the recut')
    await page.getByRole('button', { name: 'Create' }).click()

    // `create_checkpoint` emits NO `project:changed` — this row only appears
    // because the Panel refetches the view for itself.
    await expect(checkpointRows(page)).toHaveCount(1)
    await expect(checkpointRows(page)).toContainText('before the recut')
    await expect(page.locator('.history-checkpoints-empty')).toHaveCount(0)

    // ── Checkpoint: edit past it, then restore ────────────────────────────
    const e = await invokeCmd<string>(page, 'add_color_layer', {
      tStartUs: 4_000_000,
      durationUs: 1_000_000,
    })
    await expect.poll(() => layerIds(page)).toEqual([a, d, e])
    const rowsBeforeRestore = await entryRows(page).count()

    await checkpointRows(page).locator('button', { hasText: 'Restore' }).click()
    await expect.poll(() => layerIds(page)).toEqual([a, d])
    // Restore RECORDS a new entry rather than moving the cursor, so the stack
    // below GREW a row. That is correct, not a bug (docs/features.md:41).
    await expect(entryRows(page)).toHaveCount(rowsBeforeRestore + 1)
    await expect(futureRows(page)).toHaveCount(0)

    // ── Checkpoint: delete, behind a confirmation ─────────────────────────
    await checkpointRows(page).locator('button', { hasText: 'Delete' }).click()
    await expect(page.getByText('Delete checkpoint?')).toBeVisible()
    // Still there: the dialog is the gate, not a formality.
    await expect(checkpointRows(page)).toHaveCount(1)
    await page.getByRole('button', { name: 'Delete checkpoint' }).click()

    // Same no-broadcast story as create: only the Panel's own refetch clears it.
    await expect(checkpointRows(page)).toHaveCount(0)
    await expect(page.locator('.history-checkpoints-empty')).toBeVisible()
    // Deleting a checkpoint is not an edit — the stack is untouched by it.
    await expect(entryRows(page)).toHaveCount(rowsBeforeRestore + 1)
  } finally {
    await app.close()
  }
})
