// rememberGeometry's capture discipline, driven through a stub BrowserWindow.
// The maximized/fullscreen arm exists for macOS: a window zoomed from birth
// has no pre-zoom rect, so getNormalBounds() reports the zoomed frame as
// "normal" bounds — persisting that overwrites a good restore-down size and
// made the stored rect differ between the first and later launches (the
// window-geometry drift e2e failure on the mac CI leg).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { markInternalWindow, quitIfLastUserWindowClosed, rememberGeometry, userFacingWindows } from './windows'
import type { Rect, WindowGeometry, WindowGeometryStore } from './windowGeometry'

// The window list and app.quit() are all the quit gate touches. vi.hoisted
// because the factory runs during the import phase, ahead of a plain `const`.
const { listed, quits } = vi.hoisted(() => ({
  listed: [] as unknown[],
  quits: [] as number[],
}))

vi.mock('electron', () => ({
  app: { quit: () => void quits.push(1) },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return listed
    }
  },
  screen: {},
  shell: {},
}))

function fakeWin(initial: Rect) {
  const handlers = new Map<string, () => void>()
  const state = { maximized: false, fullScreen: false, normalBounds: initial }
  const win = {
    on: (ev: string, cb: () => void) => void handlers.set(ev, cb),
    isDestroyed: () => false,
    isMinimized: () => false,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    getNormalBounds: () => state.normalBounds,
  }
  return { win: win as unknown as BrowserWindow, state, fire: (ev: string) => handlers.get(ev)?.() }
}

function fakeStore() {
  let current: WindowGeometry | null = null
  const store: WindowGeometryStore = {
    get: () => current,
    remember: (_label: string, geom: WindowGeometry) => void (current = geom),
    flush: () => {},
  }
  return { store, last: () => current }
}

const NORMAL: Rect = { x: 100, y: 80, width: 1280, height: 800 }
const ZOOMED: Rect = { x: 0, y: -33, width: 1440, height: 900 }

describe('rememberGeometry — maximized capture', () => {
  it('keeps the stored rect while maximized and refreshes only the flags', () => {
    const { win, state, fire } = fakeWin(NORMAL)
    const { store, last } = fakeStore()
    rememberGeometry(win, 'main', store)

    fire('move')
    expect(last()).toEqual({ bounds: NORMAL, maximized: false, fullScreen: false })

    // macOS zoom: getNormalBounds now reads the zoomed frame.
    state.maximized = true
    state.normalBounds = ZOOMED
    fire('maximize')
    expect(last()).toEqual({ bounds: NORMAL, maximized: true, fullScreen: false })

    // Un-maximize returns to truthful normal bounds — captured verbatim again.
    state.maximized = false
    state.normalBounds = { ...NORMAL, x: 120 }
    fire('unmaximize')
    expect(last()).toEqual({ bounds: { ...NORMAL, x: 120 }, maximized: false, fullScreen: false })
  })

  it('holds the first record steady across captures for a window zoomed from birth', () => {
    const { win, state, fire } = fakeWin(ZOOMED)
    const { store, last } = fakeStore()
    state.maximized = true
    rememberGeometry(win, 'main', store)

    // Nothing stored yet — the measurement is all there is.
    fire('maximize')
    expect(last()).toEqual({ bounds: ZOOMED, maximized: true, fullScreen: false })

    // Later maximized readbacks (however the frame settles) must not move it.
    state.normalBounds = { x: 0, y: 0, width: 1024, height: 677 }
    fire('move')
    expect(last()).toEqual({ bounds: ZOOMED, maximized: true, fullScreen: false })
  })
})

// The offscreen Motif capture host is a listed BrowserWindow, so a quit decision
// made on the raw window count leaves the app running with nothing on screen.
describe('quitIfLastUserWindowClosed', () => {
  const win = (): BrowserWindow => ({ isDestroyed: () => false }) as unknown as BrowserWindow

  beforeEach(() => {
    listed.length = 0
    quits.length = 0
  })

  it('ignores an internal window when deciding who is left', () => {
    const editor = win()
    const captureHost = win()
    markInternalWindow(captureHost)
    listed.push(editor, captureHost)

    expect(userFacingWindows()).toEqual([editor])
  })

  it('quits when only the offscreen capture host is still listed', () => {
    const captureHost = win()
    markInternalWindow(captureHost)
    listed.push(captureHost) // the editor's `closed` already removed it from the list

    quitIfLastUserWindowClosed()
    expect(quits).toHaveLength(1)
  })

  it('stays alive while any user-facing window remains', () => {
    const captureHost = win()
    markInternalWindow(captureHost)
    listed.push(win(), captureHost) // e.g. the Performance Monitor outliving the editor

    quitIfLastUserWindowClosed()
    expect(quits).toHaveLength(0)
  })

  it('skips a destroyed window still in the list', () => {
    listed.push({ isDestroyed: () => true } as unknown as BrowserWindow)

    quitIfLastUserWindowClosed()
    expect(quits).toHaveLength(1)
  })
})
