// Chromakey eyedropper closed loop: pick a BLUE canvas → keyR/G/B land as one
// batched write → ONE undo reverts all three. Blue (not green) because the
// chroma defaults ARE green — a green pick would assert nothing.
import { test, expect } from '@playwright/test'
import { launchApp, newProject, invokeCmd, summary, tmpDir, waitForHook } from './helpers/driver'

interface ParamTrack { mode: string; value?: number }
interface LayerLite { id: string; effects?: Array<{ id: string; params: Record<string, ParamTrack> }> }

function chromaParams(s: { tracks: Array<{ layers: LayerLite[] }> }, layerId: string): Record<string, ParamTrack> {
  for (const t of s.tracks) {
    for (const l of t.layers) {
      if (l.id === layerId) return l.effects?.[0]?.params ?? {}
    }
  }
  throw new Error(`layer ${layerId} not in summary`)
}

/// Warm-up: force a real Pixi render and read back the center pixel through the
/// existing e2e composite-sample bridge (same one effects-smoke.spec.ts uses),
/// polling until it reads solid blue. The picker's own captureFrame() renders
/// whatever the LIVE Compositor currently holds; add_color_layer/add_effect
/// land via an async project:changed → setProject round trip, so without this
/// wait the picker can freeze a stale (pre-mutation) frame and sample the
/// dark preview letterbox surround instead of the color layer.
async function waitForBlueComposite(page: import('@playwright/test').Page): Promise<void> {
  const deadline = Date.now() + 15_000
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await page.evaluate(async () => {
      try {
        const w = window as any
        if (typeof w.__weftcutTest?.weftcutSeekUs !== 'function') return null
        w.__weftcutTest.weftcutSeekUs(500_000)
        return (await w.__weftcutTest.weftcutSampleComposite(320, 180)) as { r: number; g: number; b: number; a: number }
      } catch {
        return null
      }
    })
    if (r && r.r === 0 && r.g === 0 && r.b === 255 && r.a === 255) return
    if (Date.now() > deadline) throw new Error('composite never rendered the blue color layer (warmup failed)')
    await page.waitForTimeout(300)
  }
}

test('colorpick: chromakey eyedropper picks canvas blue; one undo reverts', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'needs a real-GL extract.pixels readback; verified locally',
  )
  test.setTimeout(120_000)
  const { app, page } = await launchApp()

  const parent = tmpDir('weftcut-colorpick-')
  await newProject(page, {
    parentFolder: parent,
    name: 'colorpick',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  const layerId = await invokeCmd<string>(page, 'add_color_layer', {
    tStartUs: 0,
    durationUs: 2_000_000,
    color: { r: 0, g: 0, b: 255, a: 255 },
  })
  await invokeCmd<string>(page, 'add_effect', { layerId, kind: 'chromakey' })
  await waitForBlueComposite(page)

  // Select the layer so PropertyPanel mounts the effects section.
  await waitForHook(page, 'revealLayer')
  await page.evaluate(
    (id) => (window as unknown as { __weftcutTest: { revealLayer(a: { layerId: string }): void } }).__weftcutTest.revealLayer({ layerId: id }),
    layerId,
  )
  // Bring the Effect tab forward: the pristine baseline docks it inactive behind
  // Attribute (workspaceLayout.ts contextual group, activeView "attribute"), which
  // leaves effect-colorpick-0 rendered but visibility:hidden. Mirrors
  // effects-smoke.spec.ts.
  await page.locator('.weft-dock-tab-label', { hasText: 'Effect' }).click()
  const pickBtn = page.getByTestId('effect-colorpick-0')
  await pickBtn.waitFor({ state: 'visible', timeout: 15_000 })
  await pickBtn.click()

  const overlay = page.getByTestId('colorpick-overlay')
  await overlay.waitFor({ state: 'visible', timeout: 15_000 })

  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('preview canvas not found')

  // Hover across the canvas first: live-apply must stay TRANSIENT — the
  // project's chromakey params record nothing until the click commits.
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(300)
  const during = chromaParams(await summary(page), layerId)
  expect(during.keyB?.value).toBeUndefined()

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await overlay.waitFor({ state: 'hidden', timeout: 10_000 })

  const near = (v: number | undefined, want: number) => {
    expect(v).toBeDefined()
    expect(Math.abs((v as number) - want)).toBeLessThan(0.02)
  }
  // The batched write lands async after the overlay settles; poll the summary.
  await expect
    .poll(async () => chromaParams(await summary(page), layerId).keyB?.value, { timeout: 10_000 })
    .toBeDefined()
  let p = chromaParams(await summary(page), layerId)
  near(p.keyR?.value, 0)
  near(p.keyG?.value, 0)
  near(p.keyB?.value, 1)

  // ONE undo reverts all three (single batched entry). add_effect creates
  // params:{} and undo restores that snapshot verbatim, so the lazily-created
  // tracks deterministically vanish (src/main/state/mutations/effects.ts +
  // history.ts snapshot restore).
  await invokeCmd(page, 'project_undo', {})
  p = chromaParams(await summary(page), layerId)
  expect(p.keyR?.value).toBeUndefined()
  expect(p.keyG?.value).toBeUndefined()
  expect(p.keyB?.value).toBeUndefined()

  await app.close()
})
