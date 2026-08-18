import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'

import { dockPanel, invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'

/**
 * A Motif's own parameter page, driven for real: the first e2e to click a
 * parameter control.
 *
 * Unreachable from the colocated Vitest suites, which hand the host adapter
 * synthetic message events. Everything asserted here is the actual round trip
 * across the sandbox boundary — `postMessage` out of an opaque-origin iframe,
 * shape-checked by the host, canonicalized against the manifest, landed as
 * `update_layer_params`, and echoed back as `propsChanged` when undo moves the
 * project underneath the page.
 *
 * Project state is read from `project_summary` (`params.props` +
 * `history.len`), never from the page's own controls: a page that only
 * repainted itself would otherwise pass.
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const LAYER_DURATION_US = 4_000_000

interface Summary {
  history: { len: number; cursor: number; can_redo: boolean }
  tracks: Array<{
    layers: Array<{ id: string; params: { kind: string; props?: Record<string, unknown> } }>
  }>
}

const summary = (page: Page) => invokeCmd<Summary>(page, 'project_summary', {})
const historyLen = async (page: Page) => (await summary(page)).history.len
/// Where the undo cursor sits. `len` counts the stack including the redo tail, so
/// it is `cursor` — not `len` — that comes back down when one undo is spent.
const historyCursor = async (page: Page) => (await summary(page)).history.cursor

async function motifProps(page: Page, layerId: string): Promise<Record<string, unknown>> {
  const s = await summary(page)
  for (const track of s.tracks) {
    for (const layer of track.layers) if (layer.id === layerId) return layer.params.props ?? {}
  }
  throw new Error(`layer ${layerId} missing from project_summary`)
}

/// Place a Motif layer at t=0 and select it, which is what binds the Attribute
/// Panel to it. `revealLayer` is the peek-item action — plain selection leaves a
/// role-less Overlay track collapsed in A/B-roll mode.
async function placeAndSelect(page: Page, motifId: string): Promise<string> {
  await waitForHook(page, 'addMotifLayer')
  await waitForHook(page, 'revealLayer')
  const added = (await page.evaluate(
    (args) =>
      (window as any).__weftcutTest
        .addMotifLayer(args)
        .then((layerId: string) => ({ ok: true, layerId }))
        .catch((e: unknown) => ({ ok: false, error: String(e) })),
    { motifId, durationUs: LAYER_DURATION_US },
  )) as { ok: boolean; layerId?: string; error?: string }
  if (!added.ok) throw new Error(`addMotifLayer(${motifId}) failed: ${added.error}`)
  const layerId = added.layerId!
  await page.evaluate((id) => (window as any).__weftcutTest.revealLayer({ layerId: id }), layerId)
  return layerId
}

const paramsFrame = (page: Page) =>
  dockPanel(page, 'attribute').locator('iframe.motif-params-frame')

/// The params page, ready to drive. The frame can appear late twice over: the
/// splash overlay outlives the first dock render, and `has_params_ui` only
/// reaches the renderer once the boot-time `list_motifs` sync lands — until then
/// the panel legitimately shows the fallback form. Then the page itself must
/// have received `init`, which the committed font_size on its slider proves.
///
/// LAST gate, and what every pointer gesture below stands on: the page declares
/// its height via `motif:resize` and the host applies it to the frame, which grows
/// from the default 240px and reflows the panel column. Waiting until the frame is
/// exactly as tall as the page says settles that reflow with no arbitrary delay,
/// and it is also what leaves the page unable to scroll inside its own frame —
/// `clickInParams` reads frame-local rects and needs no scroll term.
async function openParamsPage(page: Page, fontSize: number): Promise<FrameLocator> {
  await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })
  await expect(paramsFrame(page)).toHaveCount(1, { timeout: 30_000 })
  const ui = dockPanel(page, 'attribute').frameLocator('iframe.motif-params-frame')
  await expect(ui.locator('#f-font_size')).toHaveValue(String(fontSize), { timeout: 15_000 })
  await expect
    .poll(
      async () => {
        const frameHeight = await paramsFrame(page).evaluate((el) => el.clientHeight)
        const pageHeight = await ui
          .locator('#page')
          .evaluate((el) => Math.ceil(el.getBoundingClientRect().height))
        return frameHeight - pageHeight
      },
      { timeout: 15_000 },
    )
    .toBe(0)
  return ui
}

/// Click a control inside the params page.
///
/// NOT `locator.click()`, and not its page-coordinate box either: the page is an
/// OUT-OF-PROCESS iframe, and nothing Playwright derives ACROSS that boundary is
/// dependable. Both halves of that were measured on macOS CI, where the same
/// click either landed on nothing (the page never saw it) or never satisfied its
/// hit-target check — and a click that keeps retrying that check burns the whole
/// TEST timeout and reports a bare "Test timeout of Nms exceeded." with no call
/// log, so it reads as a wedged app rather than a missed click.
///
/// So the point comes from two SAME-frame measurements instead: the iframe's own
/// box in the host document, plus the target's rect measured inside the frame. No
/// frame-scroll term is needed — `openParamsPage` has already gated frame height
/// against page height, so the page cannot scroll under its own frame. The panel's
/// scroller is driven from the host document, where it is synchronous.
///
/// The load-bearing gate is the hover: a moved pointer lands `:hover` on the
/// target only once the browser ROUTES it into the frame's renderer, which is the
/// same routing the press takes. So the gate waits on the thing that was actually
/// failing, whatever the cause — the leading suspect is the browser's hit-test
/// geometry lagging the host's `scrollTop` write, which neither document's own
/// layout can be polled for.
///
/// The gate polls a STAGE name rather than a boolean so a stall says which half
/// gave out: 'measuring' (no frame box yet), 'scrolling' (the control is still
/// outside the panel's viewport), or 'unrouted' (the pointer is over the control
/// and the frame still doesn't see it).
async function clickInParams(page: Page, target: Locator): Promise<void> {
  const scroller = dockPanel(page, 'attribute').locator('.weft-dock-panel-scroll')
  await expect
    .poll(
      async () => {
        const frameBox = await paramsFrame(page).boundingBox()
        const view = await scroller.boundingBox()
        if (!frameBox || !view) return 'measuring'
        const local = await target.evaluate(
          (el) => {
            const r = el.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          },
          undefined,
          { timeout: 5_000 },
        )
        const x = frameBox.x + local.x + local.width / 2
        const y = frameBox.y + local.y + local.height / 2
        if (y - local.height / 2 < view.y || y + local.height / 2 > view.y + view.height) {
          await scroller.evaluate((el, d) => {
            el.scrollTop += d
          }, y - (view.y + view.height / 2))
          return 'scrolling'
        }
        await page.mouse.move(x, y)
        const hovered = await target.evaluate((el) => el.matches(':hover'), undefined, {
          timeout: 5_000,
        })
        return hovered ? 'routed' : 'unrouted'
      },
      { timeout: 20_000 },
    )
    .toBe('routed')
  // Press where the hover just proved the pointer is.
  await page.mouse.down()
  await page.mouse.up()
}

test('text-fx params page: an enum pick commits; a preview drag alone does not', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-params-'),
      name: 'motif-params-commit',
      canvas: CANVAS,
    })
    const layerId = await placeAndSelect(page, 'text-fx')
    const ui = await openParamsPage(page, 72)

    // ── A pick in the page's own segmented control is a real command ────────
    const beforePick = await historyLen(page)
    expect((await motifProps(page, layerId)).h_align).toBe('center') // manifest default
    await clickInParams(page, ui.locator('.seg[data-prop="h_align"] button[data-value="left"]'))
    await expect.poll(async () => (await motifProps(page, layerId)).h_align).toBe('left')
    expect(await historyLen(page)).toBe(beforePick + 1)

    // ── A preview burst mutates nothing ────────────────────────────────────
    // Three `input` events with no `change` is exactly a slider drag that never
    // gets released: the page sends `motif:preview` only.
    const beforeDrag = await historyLen(page)
    await ui.locator('#f-font_size').evaluate((el) => {
      const range = el as HTMLInputElement
      for (const v of ['120', '180', '240']) {
        range.value = v
        range.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    // The barrier is a COMMIT on another key, not a timer: it rides the same
    // ordered postMessage channel, so its arrival proves the three previews were
    // already delivered and handled.
    await clickInParams(page, ui.locator('.seg[data-prop="v_align"] button[data-value="top"]'))
    await expect.poll(async () => (await motifProps(page, layerId)).v_align).toBe('top')
    expect(await historyLen(page)).toBe(beforeDrag + 1)
    expect((await motifProps(page, layerId)).font_size).toBe(72)

    // ── Releasing the same slider commits once ─────────────────────────────
    const beforeRelease = await historyLen(page)
    await ui.locator('#f-font_size').evaluate((el) => {
      const range = el as HTMLInputElement
      range.value = '200'
      range.dispatchEvent(new Event('input', { bubbles: true }))
      range.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect.poll(async () => (await motifProps(page, layerId)).font_size).toBe(200)
    expect(await historyLen(page)).toBe(beforeRelease + 1)
  } finally {
    await app.close()
  }
})

test('text-fx params page: a preset lands three colors that ONE undo takes back', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-params-preset-'),
      name: 'motif-params-preset',
      canvas: CANVAS,
    })
    const layerId = await placeAndSelect(page, 'text-fx')
    const ui = await openParamsPage(page, 72)

    const before = await motifProps(page, layerId)
    const beforeLen = await historyLen(page)
    const beforeCursor = await historyCursor(page)

    await clickInParams(page, ui.locator('#presets button[data-preset="ember"]'))

    // One `motif:commit` carrying three keys → one `update_layer_params`.
    await expect.poll(async () => (await motifProps(page, layerId)).color).toBe('#fff1e0')
    const landed = await motifProps(page, layerId)
    expect(landed.color2).toBe('#ff5a1f')
    // 8-digit hex survives the round trip — the fallback form could not express
    // an alpha byte at all.
    expect(landed.bg_color).toBe('#1a0b05cc')
    expect(await historyLen(page)).toBe(beforeLen + 1)
    expect(await historyCursor(page)).toBe(beforeCursor + 1)

    // ── ONE undo, all three back ───────────────────────────────────────────
    // A single spent step, not three: the cursor returns to exactly where the
    // preset found it.
    await invokeCmd(page, 'project_undo', {})
    await expect.poll(async () => (await motifProps(page, layerId)).color).toBe(before.color)
    const reverted = await motifProps(page, layerId)
    expect(reverted.color2).toBe(before.color2)
    expect(reverted.bg_color).toBe(before.bg_color)
    expect(await historyCursor(page)).toBe(beforeCursor)

    // The undo reached the page as `propsChanged`, so its controls moved too —
    // a page showing the preset's colors over a reverted project would be worse
    // than no page at all.
    await expect(ui.locator('#f-color')).toHaveValue(String(before.color))
    await expect(ui.locator('#f-color2')).toHaveValue(String(before.color2))
    await expect(ui.locator('#f-bg-a')).toHaveValue('0') // #00000000 → alpha 0
  } finally {
    await app.close()
  }
})

test('countdown keeps the generated fallback form — no params page', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-params-fallback-'),
      name: 'motif-params-fallback',
      canvas: CANVAS,
    })
    const layerId = await placeAndSelect(page, 'countdown')
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

    // The generated form is live (Title Case labels off the bare prop keys).
    // Scoped to the Props section: the layer's own name field is also called
    // "Label", one section up.
    const props = dockPanel(page, 'attribute').getByRole('region', { name: 'Props' })
    const label = props.getByRole('textbox', { name: /^Label$/ })
    await expect(label).toBeVisible({ timeout: 30_000 })
    // No page was embedded, because countdown ships no params.html. Both paths
    // stay exercised: the fallback is the default, not a legacy branch.
    await expect(paramsFrame(page)).toHaveCount(0)
    // …and that absence is an ANSWER, not a not-yet: the catalog the panel
    // branches on stats the companion file per call, and reports one built-in
    // with a page and one without.
    const catalog = await invokeCmd<Array<{ id: string; has_params_ui?: boolean }>>(
      page,
      'list_motifs',
      {},
    )
    expect(catalog.find((m) => m.id === 'text-fx')?.has_params_ui).toBe(true)
    expect(catalog.find((m) => m.id === 'countdown')?.has_params_ui).toBe(false)

    // Sanity: the fallback still commits, so "no params page" is not "no form".
    const beforeLen = await historyLen(page)
    await label.fill('SET')
    await label.press('Enter')
    await expect.poll(async () => (await motifProps(page, layerId)).label).toBe('SET')
    expect(await historyLen(page)).toBe(beforeLen + 1)
  } finally {
    await app.close()
  }
})
