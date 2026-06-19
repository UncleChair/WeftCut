import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM-safe __dirname equivalent (package.json has "type": "module")
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test('a secondary window opens and closes via win:* IPC', async () => {
  const app = await electron.launch({ args: [path.resolve(__dirname, '../../out/main/index.js')] })
  const main = await app.firstWindow()
  await main.evaluate(() => (window as any).api.win.create('perf-hud', { url: '/?perfHud=1' }))
  await main.evaluate(() => (window as any).api.win.act('perf-hud', 'show'))
  await expect.poll(() => app.windows().length).toBe(2)
  const exists = await main.evaluate(() => (window as any).api.win.exists('perf-hud'))
  expect(exists).toBe(true)
  // Confirm the 2nd window's URL contains perfHud=1 (verifies it loaded the HUD route).
  const hudWin = app.windows()[1]
  const hudUrl = hudWin.url()
  expect(hudUrl).toContain('perfHud=1')
  await main.evaluate(() => (window as any).api.win.act('perf-hud', 'close'))
  await expect.poll(() => app.windows().length).toBe(1)
  await app.close()
})
