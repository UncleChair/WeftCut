import path from 'node:path'
import { BrowserWindow, shell } from 'electron'

const wins = new Map<string, BrowserWindow>()
const isDev = !!process.env['ELECTRON_RENDERER_URL']

// Lock down navigation + window creation on a window. The renderer only ever
// loads local content (the dev server in dev, file:// in prod), so: deny every
// renderer-initiated `window.open` (routing vetted https to the OS browser),
// and block any navigation that would leave the app origin. Defense-in-depth
// beneath the powerful fs:* / backend:invoke IPC surface (Electron security
// checklist). Apply to EVERY BrowserWindow.
export function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    const allowed = dev ? url.startsWith(dev) : url.startsWith('file://')
    if (!allowed) e.preventDefault()
  })
}

type SecondaryOpts = { url?: string; width?: number; height?: number; title?: string }
export function createSecondary(label: string, opts?: SecondaryOpts): void {
  let win = wins.get(label)
  if (win && !win.isDestroyed()) { win.show(); return }
  win = new BrowserWindow({
    width: opts?.width ?? 480,
    height: opts?.height ?? 320,
    title: opts?.title,
    // Show immediately. A frameless (`frame:false`) window combined with
    // `show:false` + a deferred `ready-to-show` show does NOT reliably surface
    // on Windows (mirrors the main-window fix in index.ts). backgroundColor is
    // set, so there's no white flash.
    show: true,
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  })
  wins.set(label, win)
  hardenWindow(win)
  win.on('closed', () => wins.delete(label))
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
