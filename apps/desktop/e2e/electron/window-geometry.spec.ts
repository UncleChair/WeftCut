import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type ElectronApplication } from '@playwright/test'

import { launchApp, tmpDir } from './helpers/driver'

// The main window's position/size memory (src/main/windowGeometry.ts). The unit
// tests own the sanitize rules; what only a real launch can prove is the
// Electron wiring — that the restored rect reaches the BrowserWindow
// CONSTRUCTOR, that getNormalBounds() (not getBounds()) is what gets persisted,
// that the close/quit flush lands on disk, and above all that the stored rect
// does not RATCHET across launches.
//
// Why exact-rect assertions on the readback are impossible: Electron's bounds
// API is not idempotent on a fractionally-scaled display. Ask the constructor
// for 1182×761 at scaleFactor 1.1 and getBounds() reports 1189×766. So a
// restored window is asserted to be within the deadband of what was saved, and
// the no-drift guarantee is asserted on the PERSISTED value instead — which is
// the thing users actually feel. See BOUNDS_DEADBAND_PX.
//
// Both launches share one userData dir (driver.ts's same-userData relaunch
// contract), which is also what keeps every OTHER spec on the centered default:
// a bare launchApp() mints a fresh empty dir, so no saved geometry exists.

const GEOMETRY_FILE = 'window_geometry.json'
/// Must match BOUNDS_DEADBAND_PX in src/main/windowGeometry.ts.
const DEADBAND_PX = 16

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The main window's normal (un-maximized) rect, read in the main process. */
function normalBounds(app: ElectronApplication): Promise<Rect> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getNormalBounds())
}

/** Primary display work area — the test rect is derived from it so this passes
 *  on a 1280×1024 xvfb screen as well as a 4K desktop. */
function primaryWorkArea(app: ElectronApplication): Promise<Rect> {
  return app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
}

function readGeometry(userDataDir: string): Rect & { maximized: boolean; full_screen: boolean } {
  const file = path.join(userDataDir, GEOMETRY_FILE)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    version: number
    windows: Record<string, Rect & { maximized: boolean; full_screen: boolean }>
  }
  expect(doc.version).toBe(1)
  return doc.windows['main']!
}

/** The window came back where it was left, allowing for the DPI readback slop
 *  that no accessor pair avoids. */
function expectWithinDeadband(measured: Rect, saved: Rect): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(measured[key] - saved[key]),
      `${key}: restored ${measured[key]} vs saved ${saved[key]}`,
    ).toBeLessThanOrEqual(DEADBAND_PX)
  }
}

/** A rect inset from `workArea` that still clears the window's 960×640 minimum,
 *  so the sanitizer passes it through unclamped. */
function targetRect(workArea: Rect): Rect {
  return {
    x: workArea.x + 60,
    y: workArea.y + 40,
    width: Math.min(1180, workArea.width - 120),
    height: Math.min(760, workArea.height - 80),
  }
}

function skipUnlessRoomy(workArea: Rect): void {
  test.skip(
    workArea.width < 1100 || workArea.height < 760,
    `display work area ${workArea.width}×${workArea.height} is too small to place a 960×640-minimum window`,
  )
}

test('the main window restores last session position and size', async () => {
  const userDataDir = tmpDir('wc-window-geometry-')

  // ── first session: move + resize, then quit ─────────────────────────────────
  const first = await launchApp({ userDataDir })
  try {
    const workArea = await primaryWorkArea(first.app)
    skipUnlessRoomy(workArea)
    await first.app.evaluate(async ({ BrowserWindow }, rect) => {
      BrowserWindow.getAllWindows()[0]!.setBounds(rect)
    }, targetRect(workArea))
  } finally {
    // close() drives app shutdown, which is what exercises the geometry flush
    // (the window's own `close` handler plus the before-quit hook in index.ts).
    await first.app.close()
  }

  const saved = readGeometry(userDataDir)
  expect(saved).toMatchObject({ maximized: false, full_screen: false })
  // The resize escaped the deadband, so what landed on disk is the real rect —
  // not the 1440×900 default the window booted with.
  expect(saved.width).not.toBe(1440)

  // ── second session: the window opens where it was left ──────────────────────
  const second = await launchApp({ userDataDir })
  try {
    // Read via getNormalBounds() rather than a screenshot because the value must
    // come from the CONSTRUCTOR — a post-construction setBounds() would satisfy a
    // pixel check while still showing the user a visible jump.
    expectWithinDeadband(await normalBounds(second.app), saved)
    expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(false)
  } finally {
    await second.app.close()
  }
})

test('the stored rect does not drift across repeated launches', async () => {
  // THE REGRESSION THIS FILE EXISTS FOR. Electron's bounds API is not idempotent
  // on a fractionally-scaled display, so persisting whatever getBounds() reports
  // and feeding it back to the constructor grows the window every single launch —
  // measured at +7px/launch on a 1.1× display, monotonic, no convergence. Three
  // untouched launches must leave byte-identical geometry on disk.
  const userDataDir = tmpDir('wc-window-geometry-drift-')
  const seen: string[] = []
  for (let launch = 0; launch < 3; launch++) {
    const { app } = await launchApp({ userDataDir })
    // No interaction at all: the only writes are the ones the app makes itself.
    await app.close()
    seen.push(JSON.stringify(readGeometry(userDataDir)))
  }
  expect(new Set(seen).size, `geometry drifted across launches:\n${seen.join('\n')}`).toBe(1)
})

test('a maximized window reopens maximized and keeps its restore-down size', async () => {
  const userDataDir = tmpDir('wc-window-geometry-max-')

  const first = await launchApp({ userDataDir })
  let workArea: Rect
  try {
    workArea = await primaryWorkArea(first.app)
    skipUnlessRoomy(workArea)
    await first.app.evaluate(async ({ BrowserWindow }, rect) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.setBounds(rect)
      win.maximize()
    }, targetRect(workArea))
    // Maximize is a window-manager operation: bare xvfb runs without a WM, so
    // the request can be a no-op there. Skip rather than assert a state the
    // platform never entered.
    const maximized = await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())
    test.skip(!maximized, 'window manager did not honor maximize()')
  } finally {
    await first.app.close()
  }

  const saved = readGeometry(userDataDir)
  expect(saved.maximized).toBe(true)
  // THE LANDMINE THIS ASSERTION GUARDS: getBounds() would have reported the
  // MAXIMIZED rect here. Persisting that makes "restore down" a no-op on the
  // next launch, because the normal size would equal the maximized size.
  expect(saved.width).toBeLessThan(workArea.width)

  const second = await launchApp({ userDataDir })
  try {
    const read = () =>
      second.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]!
        return { maximized: w.isMaximized(), normal: w.getNormalBounds() }
      })
    await expect.poll(async () => (await read()).maximized, { timeout: 10_000 }).toBe(true)
    // Un-maximizing must land back on the pre-maximize rect, not fill the screen.
    expectWithinDeadband((await read()).normal, saved)
  } finally {
    await second.app.close()
  }
})

test('an off-screen saved rect is discarded rather than opening an unreachable window', async () => {
  const userDataDir = tmpDir('wc-window-geometry-stale-')
  fs.mkdirSync(userDataDir, { recursive: true })
  // Simulates the real failure: saved on a second monitor that is now
  // unplugged. Restoring it verbatim would open a FRAMELESS window with no OS
  // titlebar off the side of the screen — unrecoverable without deleting this
  // very file.
  fs.writeFileSync(
    path.join(userDataDir, GEOMETRY_FILE),
    JSON.stringify({
      version: 1,
      windows: { main: { x: 30000, y: 20000, width: 1280, height: 800, maximized: false, full_screen: false } },
    }),
  )

  const { app } = await launchApp({ userDataDir })
  try {
    const workArea = await primaryWorkArea(app)
    const bounds = await normalBounds(app)
    // Falls back to the centered default, which must overlap the real display.
    expect(bounds.x).toBeLessThan(workArea.x + workArea.width)
    expect(bounds.y).toBeLessThan(workArea.y + workArea.height)
    expect(bounds.x + bounds.width).toBeGreaterThan(workArea.x)
    expect(bounds.y + bounds.height).toBeGreaterThan(workArea.y)
  } finally {
    await app.close()
  }
})
