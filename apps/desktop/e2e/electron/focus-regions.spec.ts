// Focus regions in the real renderer (ADR 0041). The unit tests prove the
// listener's logic in jsdom; only Chromium can prove the two things jsdom
// cannot model: that a canceled `pointerdown` really does suppress the focus
// move (the bug this work fixed), and that a capture-phase listener at `window`
// really does run ahead of the React handler that cancels it.

import { test, expect } from '@playwright/test'
import { launchApp, newProject, invokeCmd, tmpDir, waitForHook } from './helpers/driver'

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

/// One text layer, so the timeline has a clip to rename. An empty project
/// renders every Panel's empty state — the Media Pool returns early at zero
/// media, and nothing anywhere mounts an `<input>` — which makes it a fine
/// region-wiring fixture but proves nothing about release.
///
/// `revealLayer` is not optional: in A/B-roll mode a role-null Overlay track
/// stays COLLAPSED and its LayerBlock never mounts until revealed (see the hook's
/// own docstring). Without it `.timeline-layer` simply never appears.
async function projectWithClip(page: Awaited<ReturnType<typeof launchApp>>['page']) {
  const parent = tmpDir('weftcut-focus-')
  await newProject(page, { parentFolder: parent, name: 'focus', canvas: CANVAS })
  const layerId = await invokeCmd<string>(page, 'add_text_layer', {
    tStartUs: 0,
    durationUs: 2_000_000,
    content: 'before',
  })
  await waitForHook(page, 'revealLayer')
  await page.evaluate(
    (id) =>
      (
        window as unknown as {
          __weftcutTest: { revealLayer(a: { layerId: string }): void }
        }
      ).__weftcutTest.revealLayer({ layerId: id }),
    layerId,
  )
  await expect(page.locator('.timeline-layer').first()).toBeVisible({ timeout: 20_000 })
}

/// The rename input on a timeline clip: a real field on a real commit-on-blur
/// path whose commit is visible in the DOM afterwards, so "released" and
/// "committed" can be asserted without reaching into project state.
async function beginRename(page: Awaited<ReturnType<typeof launchApp>>['page']) {
  const clip = page.locator('.timeline-layer').first()
  await clip.dblclick()
  const input = page.locator('.timeline-layer input').first()
  await expect(input).toBeFocused()
  return input
}

const focusedRegion = (page: Awaited<ReturnType<typeof launchApp>>['page']) =>
  page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.dataset.focusRegion ?? null,
  )

test('every open Panel is a focus region', async () => {
  const { app, page } = await launchApp()
  try {
    const parent = tmpDir('weftcut-focus-')
    await newProject(page, { parentFolder: parent, name: 'focus-regions', canvas: CANVAS })

    // One edit in the Panel renderer covers all of them; a Panel that stopped
    // being a region would silently drop every scoped binding inside it.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-focus-region]'))
            .map((el) => (el as HTMLElement).dataset.focusRegion)
            .sort(),
        ),
      )
      .toEqual([
        'attribute',
        'effect',
        'media',
        'nearby',
        'preview',
        'quick-actions',
        'timeline',
        'transitions',
      ])
  } finally {
    await app.close()
  }
})

test('a press on preview content releases the field and commits the edit', async () => {
  test.setTimeout(60_000)
  const { app, page } = await launchApp()
  try {
    await projectWithClip(page)
    const input = await beginRename(page)
    await input.fill('renamed')

    // A plain click on the preview surface — non-focusable content. Before
    // regions existed this left focus parked on the rename box and the typed
    // label was never committed.
    await page.locator('[data-focus-region="preview"]').click({ position: { x: 20, y: 20 } })

    await expect.poll(() => focusedRegion(page)).toBe('preview')
    await expect(page.locator('.timeline-layer').first()).toContainText('renamed')
  } finally {
    await app.close()
  }
})

test('a pointerdown the target cancels still releases the field', async () => {
  test.setTimeout(60_000)
  const { app, page } = await launchApp()
  try {
    await projectWithClip(page)
    const input = await beginRename(page)
    await input.fill('cancelled-press')

    // Stand in for a transform-gizmo handle: a child of the preview Panel whose
    // `pointerdown` handler calls `preventDefault()` to suppress native drag and
    // text selection. That cancel suppresses the compatibility `mousedown`, so
    // the browser performs NO focus move of its own — reproducing the exact
    // failure this ADR fixed, in the engine that produces it.
    await page.evaluate(() => {
      const region = document.querySelector<HTMLElement>('[data-focus-region="preview"]')!
      const handle = document.createElement('div')
      handle.setAttribute('data-e2e-handle', '')
      handle.style.cssText = 'position:absolute;left:0;top:0;width:40px;height:40px;z-index:99'
      handle.addEventListener('pointerdown', (e) => e.preventDefault())
      region.appendChild(handle)
      const rect = handle.getBoundingClientRect()
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 5,
          clientY: rect.top + 5,
        }),
      )
      handle.remove()
    })

    await expect.poll(() => focusedRegion(page)).toBe('preview')
    await expect(page.locator('.timeline-layer').first()).toContainText('cancelled-press')
  } finally {
    await app.close()
  }
})
