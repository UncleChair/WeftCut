import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

test('fs:writeFile honors append vs truncate through the bridge', async () => {
  const tmp = path.join(os.tmpdir(), `wc-fs-${process.pid}.bin`)
  fs.rmSync(tmp, { force: true })

  const app = await electron.launch({ args: [MAIN] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Truncate-write [1,2,3], then append [4,5] — through window.api.invoke.
  await page.evaluate(async (p) => {
    await (window as any).api.invoke('fs:writeFile', { path: p, data: new Uint8Array([1, 2, 3]), append: false })
    await (window as any).api.invoke('fs:writeFile', { path: p, data: new Uint8Array([4, 5]), append: true })
  }, tmp)
  expect(Array.from(fs.readFileSync(tmp))).toEqual([1, 2, 3, 4, 5])

  // exists → true; remove → exists false.
  const existsBefore = await page.evaluate((p) => (window as any).api.invoke('fs:exists', { path: p }), tmp)
  expect(existsBefore).toBe(true)
  await page.evaluate((p) => (window as any).api.invoke('fs:remove', { path: p }), tmp)
  expect(fs.existsSync(tmp)).toBe(false)

  await app.close()
})

test('fs:* denies paths outside the allowed roots', async () => {
  // A home-dir path that is OUTSIDE temp + userData (userData lives under home,
  // but home itself is its parent, not a descendant) and outside any workspace
  // (none is open in this launch). Writable if the guard were absent, so a
  // created file would prove a bypass.
  const escape = path.join(os.homedir(), `wc-guard-escape-${process.pid}.bin`)
  fs.rmSync(escape, { force: true })

  const app = await electron.launch({ args: [MAIN] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const outcome = await page.evaluate(async (p) => {
    try {
      await (window as any).api.invoke('fs:writeFile', { path: p, data: new Uint8Array([9]), append: false })
      return 'allowed'
    } catch (e) {
      return `denied: ${String((e as Error)?.message ?? e)}`
    }
  }, escape)

  expect(outcome).toContain('denied')
  expect(fs.existsSync(escape)).toBe(false)

  await app.close()
})
