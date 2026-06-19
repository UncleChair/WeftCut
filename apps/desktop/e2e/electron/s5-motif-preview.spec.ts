// S5 e2e gate: live motif preview via offscreen CDP into the Pixi compositor.
//
// Mirrors `e2e/specs/motif/capture.e2e.js` Describe 3 ("motif live preview").
//
// Chain under test:
//   motifAddCountdown() → Compositor.compositeFrame → MotifSprite →
//   resolveMotifFrame → rasterMotifFrame (captureMotifFrameB64 via CDP host) →
//   ImageBitmap → live Pixi stage.
//
// We create a 480×480 project (countdown native size → fills the frame),
// add the countdown layer, seek to t=2.5 s, then poll weftcutSampleComposite
// until accent-colored (#ff4d4d ≈ rgb 255,77,77) pixels exceed a threshold —
// proving the CDP frames reached the live compositor on the Pixi canvas.
//
// The seek hook (`weftcutSeekUs`) throws until the PixiPreview bridge registers;
// we swallow and retry per the documented e2e gotcha.

import { test, expect } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import { launchApp, newProject, waitForHook } from './helpers/driver'

const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-s5-preview-proj')

test('S5 motif live preview: accent pixels reach the Pixi compositor via CDP', async () => {
  test.setTimeout(120_000)

  const { app, page } = await launchApp()
  try {
    // 1. Create a 480×480 / 30fps project (countdown fills the frame exactly —
    //    center pixel lands inside the numeral / arc geometry).
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-s5-prev-' + Date.now(),
      canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
    })

    // 2. Wait for editor-level hooks (installed after App mounts).
    await waitForHook(page, 'motifAddCountdown')
    await waitForHook(page, 'weftcutSampleComposite')

    // Reset the render counter that the CDP producer increments on each frame.
    await page.evaluate(() => {
      ;(window as any).__weftcutMotifPerf = { renders: 0 }
    })

    // 3. Add the countdown Motif layer (5 s span, default accent #ff4d4d).
    const addRes = await page.evaluate(() =>
      (window as any).__weftcutTest
        .motifAddCountdown()
        .then((id: string) => ({ ok: true, id }))
        .catch((e: unknown) => ({ ok: false, error: String(e) })),
    )
    if (!addRes.ok) throw new Error('motifAddCountdown failed: ' + addRes.error)
    expect(typeof addRes.id).toBe('string')
    expect(addRes.id.length).toBeGreaterThan(0)

    // 4. Give the project:changed bridge a beat before seeking.
    await page.waitForTimeout(500)

    // 5. Poll until accent content appears on the live composite — or deadline.
    //    Re-seek each round: a paused stale frame must not starve the bind.
    //    weftcutSeekUs throws until the PixiPreview bridge registers (it mounts
    //    async); swallow and continue polling per the documented gotcha.
    let s: {
      accentCount: number; accentR: number; accentG: number; accentB: number
      w: number; h: number; nonTransparent: number
    } | null = null
    let renders = 0
    const deadline = Date.now() + 25_000

    while (Date.now() < deadline) {
      await page.evaluate(() => {
        try {
          ;(window as any).__weftcutTest.weftcutSeekUs(2_500_000)
        } catch {
          // preview bridge not yet registered — next round retries
        }
      })
      await page.waitForTimeout(800)

      const snap = await page.evaluate(() =>
        (window as any).__weftcutTest
          .weftcutSampleComposite(240, 240)
          .then((p: unknown) => ({
            ok: true,
            p,
            renders: (window as any).__weftcutMotifPerf?.renders ?? 0,
          }))
          .catch((e: unknown) => ({ ok: false, error: String(e) })),
      )
      if (!snap.ok) throw new Error('weftcutSampleComposite failed: ' + snap.error)
      s = snap.p as typeof s
      renders = snap.renders as number
      console.log(
        `[s5-preview] ${s!.w}x${s!.h} nonTransparent=${s!.nonTransparent}` +
          ` accentCount=${s!.accentCount} accent=(${s!.accentR},${s!.accentG},${s!.accentB}) renders=${renders}`,
      )
      if (s!.accentCount > 200) break
    }
    if (!s) throw new Error('never sampled the composite')

    // 6. Assert accent-colored pixels from the countdown are present.
    //    #ff4d4d = rgb(255,77,77): high-red, low-green/blue.
    expect(s.accentCount).toBeGreaterThan(200)
    expect(s.accentR).toBeGreaterThan(180)
    expect(s.accentG).toBeLessThan(150)
    expect(s.accentB).toBeLessThan(150)

    // 7. Overlay transparency: the countdown backdrop is transparent — only the
    //    numeral + arc are opaque. Guards the CDP transparent-screenshot fix.
    const totalPx = s.w * s.h
    console.log(`[s5-preview] nonTransparent=${s.nonTransparent}/${totalPx}`)
    expect(s.nonTransparent).toBeGreaterThan(0) // content composited
    expect(s.nonTransparent).toBeLessThan(totalPx * 0.5) // not a white box

    // 8. At least one render came through the CDP producer.
    console.log('[s5-preview] renders:', renders)
    expect(renders).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
