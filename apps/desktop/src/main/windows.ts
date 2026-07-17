import path from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { secondaryWindowConfig, type SecondaryWinOpts } from './windowConfig.js'
import { broadcastEvent } from './broadcast.js'
import { isPageZoomShortcut, matchDevKeyAction } from './inputPolicy.js'

const wins = new Map<string, BrowserWindow>()
const isDev = !!process.env['ELECTRON_RENDERER_URL']

// Broadcast labelled secondary-window lifecycle to every renderer. Consumers
// use this to start work only while their independent window exists and to
// reconcile every close path — caption button, OS, or renderer crash.
export const WIN_OPENED_EVENT = 'weftcut://win-opened'
export const WIN_CLOSED_EVENT = 'weftcut://win-closed'

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
