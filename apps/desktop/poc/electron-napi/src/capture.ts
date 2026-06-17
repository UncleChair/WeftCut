import { BrowserWindow } from 'electron'
import { MOTIF_RUNTIME_SOURCE } from '../../../src/render/motifs/runtime'

const W = 1280
const H = 320
const FPS = 30
const SETTLE = 1
const PROPS = { title: 'Jane Doe', subtitle: 'Director of Photography', accent: '#ff4d4d', align: 'left' }

export interface HostHandle {
  win: BrowserWindow
  send: (method: string, params?: object) => Promise<any>
  captureMode: 'debugger' | 'paint'
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms)),
  ])
}

function waitForEvent(emitter: any, event: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout)
    emitter.once(event, () => { clearTimeout(timer); resolve() })
  })
}

export async function createHost(): Promise<HostHandle> {
  console.log('[capture] creating offscreen window')
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.setFrameRate(60)

  // Step 1: Load about:blank to initialize the renderer process and JS context.
  // This allows the debugger to attach and CDP commands to work immediately.
  console.log('[capture] loading about:blank to init renderer context')
  await withTimeout(win.loadURL('about:blank'), 5000, 'loadURL about:blank')
  console.log('[capture] about:blank loaded')

  // Step 2: Now attach the debugger — the renderer JS context exists.
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const send = (method: string, params: object = {}) => dbg.sendCommand(method, params)

  console.log('[capture] Page.enable')
  await withTimeout(send('Page.enable'), 5000, 'Page.enable')
  console.log('[capture] Runtime.enable')
  await withTimeout(send('Runtime.enable'), 5000, 'Runtime.enable')

  // Step 3: Register the runtime script to run before the motif page's scripts.
  console.log('[capture] registering runtime injection script')
  await withTimeout(
    send('Page.addScriptToEvaluateOnNewDocument', { source: MOTIF_RUNTIME_SOURCE }),
    5000, 'addScriptToEvaluateOnNewDocument'
  )

  // Step 4: Navigate to the real motif page.
  console.log('[capture] loading motif URL')
  await withTimeout(win.loadURL('motif://lower-third/index.html'), 10000, 'loadURL motif')
  console.log('[capture] motif page loaded')

  // ready probe: wait for __motifRender to be installed (the page script calls motif.define)
  let ready = false
  for (let i = 0; i < 120; i++) {
    const r = await send('Runtime.evaluate', {
      expression: `(typeof window.__motifRender==='function' && document.readyState==='complete')`,
      returnByValue: true,
    })
    if (r?.result?.value === true) { ready = true; console.log('[capture] ready at probe', i); break }
    if (i % 10 === 0) console.log('[capture] probe', i, 'result:', JSON.stringify(r?.result))
    await delay(50)
  }
  if (!ready) throw new Error('motif never became ready')

  // Set transparent background and correct viewport.
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })

  // Probe whether CDP captureScreenshot works for this offscreen window.
  let captureMode: 'debugger' | 'paint' = 'debugger'
  try {
    console.log('[capture] probing CDP screenshot (5s timeout)')
    const probe = await withTimeout(send('Page.captureScreenshot', { format: 'png' }), 5000, 'CDP probe screenshot')
    if (!probe?.data || probe.data.length < 100) {
      console.log('[capture] CDP screenshot returned empty/short data, switching to paint fallback')
      captureMode = 'paint'
    } else {
      console.log('[capture] CDP screenshot probe OK (' + probe.data.length + ' b64 chars), using debugger path')
    }
  } catch (err: any) {
    console.log('[capture] CDP screenshot probe threw/timed-out, switching to paint fallback:', err?.message)
    captureMode = 'paint'
  }

  return { win, send, captureMode }
}

async function captureViaPaint(win: BrowserWindow, renderExpr: string, send: (method: string, params?: object) => Promise<any>): Promise<Buffer> {
  return new Promise<Buffer>(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('paint capture timed out after 5s')), 5000)

    // Listen for the next paint event after the render settles.
    win.webContents.once('paint', (_event: any, _dirty: any, image: any) => {
      clearTimeout(timeout)
      console.log('[capture] paint event received, converting to PNG')
      resolve(image.toPNG())
    })

    // Run __motifRender; its RAF settle will trigger a repaint.
    const ev = await send('Runtime.evaluate', { expression: renderExpr, awaitPromise: true, returnByValue: true })
    if (ev?.exceptionDetails) {
      clearTimeout(timeout)
      reject(new Error('render threw: ' + JSON.stringify(ev.exceptionDetails)))
    }
  })
}

export async function captureFrame(host: HostHandle, tSec: number): Promise<Buffer> {
  const meta = { width: W, height: H, fps: FPS, settleRafs: SETTLE }
  const expr = `window.__motifRender(${JSON.stringify(tSec)}, ${JSON.stringify(PROPS)}, ${JSON.stringify(meta)})`

  if (host.captureMode === 'paint') {
    console.log('[capture] using paint fallback path for t=' + tSec)
    return captureViaPaint(host.win, expr, host.send)
  }

  // Debugger (CDP) path
  console.log('[capture] using CDP debugger path for t=' + tSec)
  const ev = await host.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (ev?.exceptionDetails) throw new Error('render threw: ' + JSON.stringify(ev.exceptionDetails))
  const shot = await host.send('Page.captureScreenshot', { format: 'png' })
  return Buffer.from(shot.data, 'base64')
}
