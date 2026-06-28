import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './helpers/driver'

// Preview pan correctness — renders the REAL buildPanGraph + panCurves in an
// OfflineAudioContext and checks output L/R against the equal-power law. This
// covers the matrix-mixer WIRING (channel topology, 4-gain summing) that the
// headless math goldens cannot reach (docs/audio.md §Preview mixer).
test.describe('preview pan matrix mixer (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  test.beforeAll(async () => { ({ app, page } = await launchApp()) })
  test.afterAll(async () => { await app?.close() })

  // L/R RMS for a constant input of 1.0 per channel under the equal-power law.
  const expectLr = (channels: number, pan: number): { l: number; r: number } => {
    const x = channels <= 1 ? (pan + 1) / 2 : pan <= 0 ? pan + 1 : pan
    const c = Math.cos((x * Math.PI) / 2)
    const s = Math.sin((x * Math.PI) / 2)
    if (channels <= 1) return { l: c, r: s }
    return pan <= 0 ? { l: 1 + c, r: s } : { l: c, r: 1 + s }
  }

  for (const ch of [1, 2]) {
    for (const pan of [-0.8, 0, 0.5]) {
      test(`channels=${ch} pan=${pan} matches equal-power L/R`, async () => {
        const probe = (await page.evaluate(
          (a) => (window as any).__weftcutTest.panRenderProbe(a),
          { channels: ch, pan, frames: 48_000 },
        )) as { l: number; r: number }
        const want = expectLr(ch, pan)
        console.log(`[e2e] pan preview ch=${ch} pan=${pan}`, JSON.stringify({ probe, want }))
        expect(probe.l).toBeCloseTo(want.l, 2)
        expect(probe.r).toBeCloseTo(want.r, 2)
      })
    }
  }
})
