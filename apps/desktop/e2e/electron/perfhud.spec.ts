import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM-safe __dirname equivalent (package.json has "type": "module")
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test('the PerfHUD popup opens frameless with a self-drawn titlebar', async () => {
  const app = await electron.launch({ args: [path.resolve(__dirname, '../../out/main/index.js')] })
  const main = await app.firstWindow()
  // decorations:false mirrors what openPerfHudWindow() passes in the real app:
  // frameless, so the renderer draws its own titlebar + window controls.
  await main.evaluate(() =>
    (window as any).api.win.create('perf-hud', { url: '/?perfHud=1', decorations: false }),
  )
  await main.evaluate(() => (window as any).api.win.act('perf-hud', 'show'))
  await expect.poll(() => app.windows().length).toBe(2)
  const exists = await main.evaluate(() => (window as any).api.win.exists('perf-hud'))
  expect(exists).toBe(true)
  // Confirm the 2nd window's URL contains perfHud=1 (verifies it loaded the HUD route).
  const hudWin = app.windows()[1]
  expect(hudWin.url()).toContain('perfHud=1')

  // The window is frameless: with no OS frame, outer bounds ≈ content bounds
  // (Windows leaves only a ~1px invisible resize border). A NATIVE title bar
  // would add ~30px — so a small delta proves the bar is the renderer's own.
  const frame = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('perfHud=1'),
    )
    if (!w) return null
    const outer = w.getBounds()
    const content = w.getContentBounds()
    return { dh: outer.height - content.height }
  })
  expect(frame).not.toBeNull()
  expect(frame!.dh).toBeLessThan(8)

  // The self-drawn titlebar + its caption buttons are present in the popup DOM.
  await expect(hudWin.locator('[data-testid="perf-hud-titlebar"]')).toBeVisible()
  await expect(hudWin.locator('.window-control-close')).toBeVisible()

  // Clicking the popup's OWN close button closes the POPUP, not the main editor
  // (regression guard for the sender-window IPC routing — window:close must act
  // on the window that sent it, not always mainWindow).
  await hudWin.locator('.window-control-close').click()
  await expect.poll(() => app.windows().length).toBe(1)
  expect(app.windows()[0]!.url()).not.toContain('perfHud=1')

  await app.close()
})
