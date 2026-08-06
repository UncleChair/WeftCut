import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

test('motif: protocol serves built-ins via the Rust brain; 404s unknown', async () => {
  // launchApp awaits the first window, so app.whenReady() has completed and
  // registerMotifProtocol(motifBuiltinDir, motifStore) has been called.
  const { app } = await launchApp()
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
