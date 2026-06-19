import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { MAIN } from './helpers/driver'

test('motif: protocol serves built-ins via the Rust brain; 404s unknown', async () => {
  const app = await electron.launch({ args: [MAIN] })
  // Wait for the renderer window to be ready — this ensures app.whenReady() has
  // completed and registerMotifProtocol(backend) has been called.
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Run in MAIN where net.fetch + the motif scheme are available.
  const res = await app.evaluate(async ({ net }) => {
    const ok = await net.fetch('motif://countdown/index.html')
    const body = await ok.text()
    const miss = await net.fetch('motif://nope/index.html')
    return { okStatus: ok.status, hasDefine: body.includes('motif.define'), missStatus: miss.status }
  })
  expect(res.okStatus).toBe(200)
  expect(res.hasDefine).toBe(true)
  expect(res.missStatus).toBe(404)
  await app.close()
})
