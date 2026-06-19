import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

test('export:videosink_write channel is exposed and write-without-sink rejects cleanly', async () => {
  const { app, page } = await launchApp()
  try {
    const hasFn = await page.evaluate(
      () => typeof (window as any).api?.videoSinkWrite === 'function',
    )
    expect(hasFn).toBe(true)

    // No active sink => the napi method's "no active video sink" error must
    // surface as a rejected promise, not a crash.
    const rejected = await page.evaluate(async () => {
      try {
        await (window as any).api.videoSinkWrite(new Uint8Array(16))
        return 'resolved'
      } catch (e) {
        return String(e)
      }
    })
    expect(rejected).toContain('no active video sink')
  } finally {
    await app.close()
  }
})
