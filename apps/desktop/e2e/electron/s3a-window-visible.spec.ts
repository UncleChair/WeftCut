import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM-safe __dirname (package.json has "type": "module").
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Regression guard for the show-race bug: the main window was created with
// `show: false` and `win.show()` was only called from a `ready-to-show`
// listener registered AFTER `await win.loadURL()` returned — so it raced the
// event and missed it, leaving the window invisible forever. Playwright
// `_electron` and `capturePage` both operate on hidden windows, so no other
// gate exercises actual window visibility. This one does.
test('main window becomes visible after launch', async () => {
  const app = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
  })
  await app.firstWindow()

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
