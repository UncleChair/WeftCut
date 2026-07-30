import path from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { secondaryWindowConfig, type SecondaryWinOpts } from './windowConfig.js'
import { broadcastEvent } from './broadcast.js'
import { isPageZoomShortcut, matchDevKeyAction } from './inputPolicy.js'
import { WIN_CLOSED_EVENT, WIN_OPENED_EVENT } from '../shared/windowEvents.js'
import {
  sanitizeGeometry,
  withinDeadband,
  type GeometryDefaults,
  type Rect,
  type RestoredGeometry,
  type WindowGeometryStore,
} from './windowGeometry.js'

const wins = new Map<string, BrowserWindow>()
const isDev = !!process.env['ELECTRON_RENDERER_URL']

// Lock down navigation + window creation on a window. The renderer only ever
// loads local content (the dev server in dev, file:// in prod), so: deny every
// renderer-initiated `window.open`, and block any navigation that would leave
// the app origin. Defense-in-depth beneath the powerful fs:* / backend:invoke
// IPC surface (Electron security checklist). Apply to EVERY BrowserWindow.
//
// `allowExternalOpen` (default true) routes a vetted https `window.open` to the
// OS browser — right for the trusted app shell. Windows hosting UNTRUSTED content
// (the Motif capture host) MUST pass `false`: a malicious Motif could otherwise
// pop the user's browser to an arbitrary https URL via `window.open`.
export function hardenWindow(win: BrowserWindow, opts?: { allowExternalOpen?: boolean }): void {
  const allowExternalOpen = opts?.allowExternalOpen ?? true
  // WeftCut has no interface-scale setting. Chromium nevertheless enables its
  // built-in Ctrl/Cmd +/-/0 page zoom, which can accidentally shrink the whole
  // application. Consume only those keyboard accelerators; renderer-owned
  // gestures such as the timeline's Ctrl+wheel zoom continue to work.
  const resetPageZoom = (): void => win.webContents.setZoomFactor(1)
  resetPageZoom()
  win.webContents.on('did-finish-load', resetPageZoom)
  win.webContents.on('before-input-event', (event, input) => {
    if (isPageZoomShortcut(input)) { event.preventDefault(); return }
    // Dev reload/DevTools/fullscreen ride this shared handler, so they cover the
    // main and secondary (Performance Monitor) windows alike. See ADR 0031; matchDevKeyAction
    // owns the isDev gate.
    const devAction = matchDevKeyAction(input, isDev)
    if (!devAction) return
    event.preventDefault()
    const wc = win.webContents
    if (devAction === 'reload') wc.reload()
    else if (devAction === 'forceReload') wc.reloadIgnoringCache()
    else if (devAction === 'toggleDevTools') wc.toggleDevTools()
    else if (devAction === 'toggleFullscreen') win.setFullScreen(!win.isFullScreen())
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (allowExternalOpen && /^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    const allowed = dev ? url.startsWith(dev) : url.startsWith('file://')
    if (!allowed) e.preventDefault()
  })
}

/// Read the saved geometry for `label` and validate it against the CURRENT
/// display set, yielding BrowserWindow constructor options. The `screen` module
/// is only usable after app-ready, which every caller here already is.
///
/// The result MUST be spread into the `new BrowserWindow({...})` call rather
/// than applied afterwards with setBounds(): the main window is created with
/// `show: true` (a frameless window plus `show:false` does not reliably surface
/// on Windows — see index.ts), so a post-construction move would be a visible
/// jump. `maximized` is the one field with no constructor equivalent — index.ts
/// applies it with `win.maximize()` in the same tick. Pass this same object back
/// to `rememberGeometry` as its deadband baseline.
export function restoreGeometry(
  store: WindowGeometryStore | null,
  label: string,
  defaults: GeometryDefaults,
): RestoredGeometry {
  return sanitizeGeometry(store?.get(label) ?? null, screen.getAllDisplays(), defaults)
}

/// Persist `win`'s geometry as the user moves/resizes it.
///
/// LANDMINE: capture getNormalBounds(), NOT getBounds(). While maximized (or
/// fullscreen) getBounds() returns the *maximized* rect — persist that and the
/// next launch restores a window whose "restore down" size equals its maximized
/// size, so un-maximizing appears to do nothing. getNormalBounds() is Electron's
/// accessor for the pre-maximize rect and is exactly what we want to keep.
///
/// Minimized windows are skipped: their reported bounds are unreliable on
/// Windows and `isMaximized()` reads false even for a window that was maximized
/// before being minimized — capturing there would silently drop the maximize
/// state. Keeping the last known-good record is strictly better.
///
/// `requested` is `restoreGeometry`'s own return value — the exact object spread
/// into the BrowserWindow constructor — and passing it is what stops the window
/// growing a few pixels per launch. Electron reports back a slightly different
/// rect than it was given on a fractionally-scaled display (see
/// BOUNDS_DEADBAND_PX for the measured ratchet), so while the measurement stays
/// within that slop we persist `requested` verbatim rather than the measurement.
/// The deadband is dropped PERMANENTLY at the first genuine resize, so the only
/// thing it can cost is a sub-16px nudge made as the very first gesture of a
/// session — everything after that is recorded exactly.
export function rememberGeometry(
  win: BrowserWindow,
  label: string,
  store: WindowGeometryStore | null,
  requested?: RestoredGeometry,
): void {
  if (!store) return
  // The rect we asked for, held until a real resize proves the user has moved
  // off it. null → trust measurements verbatim from here on.
  //
  // A first launch requests a SIZE but no position (x/y absent so Chromium
  // centers). Filling the gap from the window's actual placement makes the
  // baseline complete, so even the very first session persists the size we asked
  // for rather than the inflated readback — the ratchet never gets a first step.
  let baseline: Rect | null = null
  if (requested) {
    const placed = win.getNormalBounds()
    baseline = {
      x: requested.x ?? placed.x,
      y: requested.y ?? placed.y,
      width: requested.width,
      height: requested.height,
    }
  }
  const capture = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    const measured = win.getNormalBounds()
    if (baseline && !withinDeadband(measured, baseline)) baseline = null
    store.remember(label, {
      bounds: baseline ?? measured,
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    })
  }
  // `resize`/`move` fire continuously through a drag — the store debounces them.
  win.on('resize', capture)
  win.on('move', capture)
  // Discrete state flips: capture so the flag is recorded even when the drag
  // handlers never run (Win+Up, double-click drag region, macOS green button).
  win.on('maximize', capture)
  win.on('unmaximize', capture)
  win.on('enter-full-screen', capture)
  win.on('leave-full-screen', capture)
  // `close` fires while the window is still alive, so bounds are readable here.
  // Flush synchronously: a move inside the debounce window would otherwise die
  // with the window. This also covers macOS ⌘W, which closes without quitting
  // and so never reaches the before-quit flush in index.ts.
  win.on('close', () => {
    capture()
    store.flush()
  })
}

export function createSecondary(label: string, opts?: SecondaryWinOpts): void {
  let win = wins.get(label)
  if (win && !win.isDestroyed()) {
    win.show()
    broadcastEvent(BrowserWindow.getAllWindows(), WIN_OPENED_EVENT, { label })
    return
  }
  // secondaryWindowConfig decides the frame: a window passing `decorations:false`
  // is frameless and draws its OWN titlebar + <WindowControls/> (the Performance
  // Monitor); everything else gets the native OS frame by default. See
  // windowConfig.ts.
  win = new BrowserWindow({
    ...secondaryWindowConfig(opts),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  })
  wins.set(label, win)
  broadcastEvent(BrowserWindow.getAllWindows(), WIN_OPENED_EVENT, { label })
  hardenWindow(win)
  // Maximize-state feed for a frameless secondary window's own caption glyph —
  // same payload the main window ships (index.ts). Sent only to THIS window, so
  // each window's <WindowControls/> tracks its own state. No-op for OS-framed
  // secondary windows (their renderer doesn't draw the glyph).
  const sendMax = (): void => {
    if (!win!.isDestroyed())
      win!.webContents.send('evt:window:maximize-changed', { isMaximized: win!.isMaximized() })
  }
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)
  win.on('closed', () => {
    wins.delete(label)
    broadcastEvent(BrowserWindow.getAllWindows(), WIN_CLOSED_EVENT, { label })
  })
  // Pass the caller's renderer-relative url straight through (e.g. '/?perfHud=1').
  const rel = opts?.url ?? '/'
  if (isDev) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']! + rel)
  } else {
    const u = new URL(rel, 'http://x') // parse path/search/hash of the relative url
    const file = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '')
    // Reconcile loadFile's option semantics against the installed Electron 42:
    // `search` is the query string (sans leading '?'), `hash` the fragment (sans '#').
    void win.loadFile(path.join(__dirname, '../renderer', file), {
      search: u.search ? u.search.slice(1) : undefined,
      hash: u.hash ? u.hash.slice(1) : undefined,
    })
  }
}
export function actOnSecondary(label: string, action: 'show' | 'hide' | 'close' | 'center' | 'focus'): void {
  const win = wins.get(label)
  if (!win || win.isDestroyed()) return
  if (action === 'show') win.show()
  else if (action === 'hide') win.hide()
  else if (action === 'close') win.close()
  else if (action === 'center') win.center()
  else if (action === 'focus') win.focus()
}
export function secondaryExists(label: string): boolean {
  const win = wins.get(label)
  return !!win && !win.isDestroyed()
}
