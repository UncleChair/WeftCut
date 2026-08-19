// e2e gate: closing the last window ends the process — including after a Motif has
// been rendered, when the offscreen capture host is still a listed BrowserWindow
// and `window-all-closed` will never fire again (main/windows.ts →
// quitIfLastUserWindowClosed). Both tests press the same `window:close` IPC the
// titlebar ✕ invokes.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './helpers/driver'

/// Windows Electron itself counts — the offscreen capture host included.
function listedWindows(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

/// Press the titlebar ✕. The invoke never resolves (its own window dies mid-call),
/// so it is fired and forgotten rather than awaited.
function pressCloseButton(page: Page): void {
  void page
    .evaluate(() => void (window as unknown as { api: { window: { close(): Promise<void> } } }).api.window.close())
    .catch(() => {
      // "Target closed" — the window went away, which is the point.
    })
}

async function expectProcessExits(app: ElectronApplication, why: string): Promise<void> {
  const proc = app.process()
  await expect
    .poll(() => proc.exitCode, { timeout: 20_000, message: `the process never exited after ${why}` })
    .not.toBeNull()
}

test('closing the window quits the app after a Motif has been rendered', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    const beforeCapture = await listedWindows(app)

    // One frame of a builtin Motif is enough to build the offscreen host. The
    // renderer registered the clock-takeover runtime at boot (main.tsx).
    const png = await page.evaluate(
      () =>
        (window as any).api.backend.invoke('motif_capture_frame', {
          motifId: 'lower-third',
          tSec: 0.5,
          propsJson: '{}',
          width: 320,
          height: 180,
          settleRafs: 1,
          contentHash: '',
        }) as Promise<string>,
    )
    // By signature, not size: a default lower-third is mostly transparent and
    // compresses to well under a kilobyte.
    expect(png.startsWith('iVBORw0KGgo')).toBe(true)

    // The root cause, asserted rather than assumed — the host is now one more
    // window in Electron's own count.
    expect(await listedWindows(app)).toBe(beforeCapture + 1)

    pressCloseButton(page)
    await expectProcessExits(app, 'the window closed with a Motif capture host open')
  } finally {
    await app.close().catch(() => {}) // may already have exited; the wrapper still reaps the temp dir
  }
})

// Control arm: no host, so this path always worked. If BOTH tests fail, suspect
// the launch/close plumbing rather than the quit gate.
test('closing the window quits the app when no Motif was ever rendered', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    expect(await listedWindows(app)).toBe(1)
    pressCloseButton(page)
    await expectProcessExits(app, 'the window closed with no Motif capture host')
  } finally {
    await app.close().catch(() => {}) // may already have exited
  }
})
