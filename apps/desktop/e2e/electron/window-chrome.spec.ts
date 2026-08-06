import { test, expect, type ElectronApplication } from '@playwright/test'

import { launchApp, newProject, tmpDir } from './helpers/driver'

// The main window's macOS caption chrome: `titleBarStyle: 'hidden'` keeps the
// OS-drawn traffic lights, and the renderer insets its own titlebars to clear
// them (src/main/index.ts, app.css / startup.css / perf.css). Two behaviours here
// only a real launch can prove, both of which regressed once:
//
//  1. Window appearance. The traffic lights are drawn through the WINDOW's
//     appearance, not the page's. With themeSource left at 'system', a light-mode
//     host drew the INACTIVE buttons in light-chrome grey — invisible against our
//     #0a0a0a caption, so an unfocused window looked like it had no buttons.
//     `color-scheme: dark` cannot fix this: it governs only what Chromium paints.
//
//  2. Inset timing on leaving fullscreen. The inset must be driven by
//     env(titlebar-area-x), which `titleBarOverlay: true` publishes — never by
//     Electron's 'leave-full-screen' event; see the regression guard below for
//     why that event is too late.

const isDarwin = process.platform === 'darwin'

/// Minimal shape of the Window Controls Overlay API (not in the DOM lib).
interface OverlayLike {
  visible: boolean
  addEventListener(type: 'geometrychange', cb: (e: { visible: boolean }) => void): void
}
declare global {
  interface Navigator {
    windowControlsOverlay?: OverlayLike
  }
  interface Window {
    __insetWhenOverlayReturned?: number | null
  }
}

/// The startup screen's title strip — the surface on show at launch, and one of
/// the bars that must clear the traffic lights.
const TITLEBAR = '.startup-titlebar'

function setFullScreen(app: ElectronApplication, on: boolean): Promise<void> {
  return app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]!.setFullScreen(value)
  }, on)
}

test('window appearance is pinned dark, so macOS draws legible traffic lights', async () => {
  const { app } = await launchApp()

  // Asserted on every platform: it is one app-wide setting, and on Win/Linux it
  // still keeps native menus and dialogs in step with the dark UI.
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(true)

  await app.close()
})

test.describe('macOS traffic-light inset @serial', () => {
  // Traffic lights and the overlay env vars exist only on macOS; elsewhere the
  // window is fully frameless and the renderer draws its own caption buttons.
  test.skip(!isDarwin, 'macOS-only window chrome')

  test('titlebar clears the buttons, and re-insets as fullscreen exit BEGINS', async () => {
    const { app, page } = await launchApp()
    await page.waitForSelector(TITLEBAR)

    const measure = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)!
        const cs = getComputedStyle(el)
        return {
          overlayVisible: navigator.windowControlsOverlay?.visible,
          padLeft: parseFloat(cs.paddingLeft),
          height: parseFloat(cs.height),
        }
      }, selector)

    // Enabled by `titleBarOverlay: true`; without it there are no env vars and
    // every inset below silently collapses to its fallback.
    expect(await page.evaluate(() => !!navigator.windowControlsOverlay)).toBe(true)

    const normal = await measure(TITLEBAR)
    expect(normal.overlayVisible).toBe(true)
    // Chromium's own safe-content edge — ~86px for our trafficLightPosition.
    // Asserted as a floor, not a constant: it is the OS's number, not ours.
    expect(normal.padLeft).toBeGreaterThan(60)
    // The strip must CONTAIN the button band or the buttons hang onto content.
    expect(normal.height).toBeGreaterThanOrEqual(34)

    // The green stoplight must offer NATIVE fullscreen. Guards a trap that had
    // already sprung: the geometry restore passed `fullscreen: false` on every
    // normal launch, and Electron reads that as "disable the fullscreen button",
    // degrading the green button to a plain zoom (src/main/index.ts).
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreenable()),
    ).toBe(true)

    const buttonsBefore = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
    )

    // --- fullscreen hides the buttons: the inset must collapse to its fallback
    await setFullScreen(app, true)
    await page.waitForFunction(() => navigator.windowControlsOverlay?.visible === false)
    const fullscreen = await measure(TITLEBAR)
    expect(fullscreen.padLeft).toBe(0)

    // --- arm the capture BEFORE triggering the exit, so there is no race between
    // installing the listener and the transition starting.
    await page.evaluate(() => {
      window.__insetWhenOverlayReturned = null
      navigator.windowControlsOverlay!.addEventListener('geometrychange', (e) => {
        if (!e.visible || window.__insetWhenOverlayReturned != null) return
        window.__insetWhenOverlayReturned = parseFloat(
          getComputedStyle(document.querySelector('.startup-titlebar')!).paddingLeft,
        )
      })
    })

    await setFullScreen(app, false)
    await page.waitForFunction(() => window.__insetWhenOverlayReturned != null)

    // THE regression guard. Chromium restores the traffic-light area at the
    // START of the exit animation while 'leave-full-screen' fires only once it
    // has FINISHED, so this value is read the instant the buttons come back —
    // before that event. An IPC-driven inset would still be reporting the
    // fullscreen value (0) here, which is exactly the frame where the title
    // overlaps the buttons.
    const insetOnReturn = await page.evaluate(() => window.__insetWhenOverlayReturned)
    expect(insetOnReturn).toBeGreaterThan(60)

    // The custom traffic-light position must survive the roundtrip. Older Electron
    // reset it on fullscreen exit, which would need a re-apply on the way out.
    const buttonsAfter = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
    )
    expect(buttonsAfter).toEqual(buttonsBefore)

    await app.close()
  })

  test('buttons sit vertically centred in every caption bar', async () => {
    const { app, page } = await launchApp()
    await page.waitForSelector(TITLEBAR)

    // The centring invariant. The buttons occupy a 14px band starting at
    // trafficLightPosition.y, and Chromium reports env(titlebar-area-height) as
    // 2y + 14 — so the band's centre is exactly half that env value, and a bar
    // is centred if and only if its own height EQUALS the env value. Bars that
    // size themselves to env (startup strip, agent row) satisfy it by
    // construction; .app-header has an intrinsic content-driven height, so
    // trafficLightPosition.y in src/main/index.ts has to match it. When this
    // fails, that y is the thing to recompute: y = (barHeight - 14) / 2.
    const centred = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)!
        const overlay = (
          navigator as { windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect } }
        ).windowControlsOverlay!.getTitlebarAreaRect()
        return { barHeight: el.getBoundingClientRect().height, bandHeight: overlay.height }
      }, selector)

    const startup = await centred(TITLEBAR)
    // Sub-pixel tolerance only: a whole-point y cannot always hit a fractional
    // bar height exactly, but anything past 1px reads as visibly off-centre.
    expect(Math.abs(startup.barHeight - startup.bandHeight)).toBeLessThanOrEqual(1)

    await newProject(page, {
      parentFolder: tmpDir('weftcut-caption-'),
      name: 'Caption',
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    await page.waitForSelector('.app-header')
    const header = await centred('.app-header')
    expect(Math.abs(header.barHeight - header.bandHeight)).toBeLessThanOrEqual(1)

    await app.close()
  })
})
