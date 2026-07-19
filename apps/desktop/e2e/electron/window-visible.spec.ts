import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

// Regression guard for the show-race bug: the main window was created with
// `show: false` and `win.show()` was only called from a `ready-to-show`
// listener registered AFTER `await win.loadURL()` returned — so it raced the
// event and missed it, leaving the window invisible forever. Playwright
// `_electron` and `capturePage` both operate on hidden windows, so no other
// gate exercises actual window visibility. This one does.
test('main window becomes visible after launch', async () => {
  const { app } = await launchApp()

  // show() may lag first paint; poll the main process for up to ~5s.
  let visible = false
  for (let i = 0; i < 50; i++) {
    visible = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return !!w && w.isVisible()
    })
    if (visible) break
    await new Promise((r) => setTimeout(r, 100))
  }

  expect(visible).toBe(true)
  await app.close()
})
