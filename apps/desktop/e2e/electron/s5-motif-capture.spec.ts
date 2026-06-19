import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

test('motif_capture_frame: deterministic transparent PNG via offscreen CDP', async () => {
  const { app, page } = await launchApp()
  // The renderer registered the runtime at boot (main.tsx). Capture countdown twice
  // at the same t — same input must yield byte-identical base64 (PoC determinism).
  const cap = (t: number) =>
    page.evaluate(
      (tSec) =>
        (window as any).api.invoke('motif_capture_frame', {
          motifId: 'countdown', tSec, propsJson: JSON.stringify({ seconds: 5, accent: '#ff4d4d' }),
          width: 480, height: 480, settleRafs: 1, contentHash: '',
        }) as Promise<string>,
      t,
    )
  const a = await cap(1.0)
  const b = await cap(1.0)
  expect(a.length).toBeGreaterThan(1000) // a real PNG, not empty
  expect(a).toBe(b)                       // same input → identical
  const c = await cap(2.0)
  expect(c).not.toBe(a)                   // different t → different frame (it animates)
  await app.close()
})
