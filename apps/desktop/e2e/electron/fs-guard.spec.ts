import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { launchApp, tmpDir } from './helpers/driver'

test('fs:writeFile honors append vs truncate through the bridge', async () => {
  const tmp = path.join(tmpDir('wc-fs-'), 'probe.bin')

  const { app, page } = await launchApp()

  // Truncate-write [1,2,3], then append [4,5] — through the named fs API.
  await page.evaluate(async (p) => {
    await (window as any).api.fs.writeFile(p, new Uint8Array([1, 2, 3]), false)
    await (window as any).api.fs.writeFile(p, new Uint8Array([4, 5]), true)
  }, tmp)
  expect(Array.from(fs.readFileSync(tmp))).toEqual([1, 2, 3, 4, 5])

  // exists → true; remove → exists false.
  const existsBefore = await page.evaluate((p) => (window as any).api.fs.exists(p), tmp)
  expect(existsBefore).toBe(true)
  await page.evaluate((p) => (window as any).api.fs.remove(p), tmp)
  expect(fs.existsSync(tmp)).toBe(false)

  await app.close()
})

test('fs:* denies paths outside the allowed roots', async () => {
  // A home-dir path that is OUTSIDE temp + userData (the isolated userData
  // profile lives under os.tmpdir(), so home is outside both roots) and
  // outside any workspace (none is open in this launch). Writable if the
  // guard were absent, so a created file would prove a bypass.
  const escape = path.join(os.homedir(), `wc-guard-escape-${process.pid}.bin`)
  fs.rmSync(escape, { force: true })

  const { app, page } = await launchApp()

  const outcome = await page.evaluate(async (p) => {
    try {
      await (window as any).api.fs.writeFile(p, new Uint8Array([9]), false)
      return 'allowed'
    } catch (e) {
      return `denied: ${String((e as Error)?.message ?? e)}`
    }
  }, escape)

  expect(outcome).toContain('denied')
  expect(fs.existsSync(escape)).toBe(false)

  await app.close()
})
