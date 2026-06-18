import { BrowserWindow } from 'electron'

type Backend = import('@weftcut/core').Backend

interface CaptureArgs {
  motifId: string
  tSec: number
  propsJson: string
  width: number
  height: number
  settleRafs: number | null
  contentHash: string
}

const CAPTURE_TIMEOUT_MS = 5000
const READY_ATTEMPTS = 30
const READY_POLL_MS = 100

let runtimeSource: string | null = null
/// The renderer registers the clock-takeover runtime once at boot
/// (`motif_register_runtime`); main injects it via addScriptToEvaluateOnNewDocument.
export function setRuntimeSource(src: string): void {
  runtimeSource = src
}

interface Host {
  win: BrowserWindow
  send: (method: string, params?: object) => Promise<any>
  loadedId: string | null
  loadedV: string | null
  readyFor: string | null
  lastSize: { w: number; h: number } | null
}
let host: Host | null = null

// Serialize ALL captures (on-demand sprite / prewarmer / baker / MCP) on the one
// host — single-threaded but await-interleaved — replacing the Rust tokio::Mutex.
let chain: Promise<unknown> = Promise.resolve()

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`motif capture timed out after ${ms}ms: ${label}`)), ms)),
  ])
}

async function buildHost(): Promise<Host> {
  if (!runtimeSource) throw new Error('motif runtime not registered yet (call motif_register_runtime)')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  })
  await withTimeout(win.loadURL('about:blank'), CAPTURE_TIMEOUT_MS, 'about:blank')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const send = (method: string, params: object = {}) => dbg.sendCommand(method, params)
  await withTimeout(send('Page.enable'), CAPTURE_TIMEOUT_MS, 'Page.enable')
  await withTimeout(send('Runtime.enable'), CAPTURE_TIMEOUT_MS, 'Runtime.enable')
  await withTimeout(send('Page.addScriptToEvaluateOnNewDocument', { source: runtimeSource }), CAPTURE_TIMEOUT_MS, 'addScript')
  return { win, send, loadedId: null, loadedV: null, readyFor: null, lastSize: null }
}

function teardownHost(): void {
  if (host) {
    try { host.win.webContents.debugger.detach() } catch { /* already gone */ }
    try { host.win.destroy() } catch { /* already gone */ }
    host = null
  }
}

async function ensureHost(motifId: string, contentHash: string): Promise<Host> {
  if (!host) host = await buildHost()
  // Reuse only when BOTH id and content version match (the ?v= cache-buster).
  if (host.loadedId === motifId && host.loadedV === contentHash) return host
  const url = `motif://${motifId}/index.html?v=${encodeURIComponent(contentHash)}`
  await withTimeout(host.win.loadURL(url), CAPTURE_TIMEOUT_MS * 2, 'loadURL motif')
  host.loadedId = motifId
  host.loadedV = contentHash
  host.readyFor = null // re-probe; navigation re-runs addScriptToEvaluateOnNewDocument
  host.lastSize = null // re-apply setDeviceMetricsOverride for the new page
  return host
}

async function waitReady(h: Host, motifId: string): Promise<void> {
  if (h.readyFor === motifId) return
  // Throw-until-ready: a false boolean would resolve to ready falsely. The
  // hostname guard closes the navigate→stale-page race: with `standard:true`
  // motif://<id>/index.html parses with hostname===id, so we verify the loaded
  // page is actually the motif we want (not a stale about:blank or prior motif).
  const probe =
    `(typeof window.__motifRender==='function' && document.readyState==='complete'` +
    ` && location.hostname===${JSON.stringify(motifId)})`
  for (let i = 0; i < READY_ATTEMPTS; i++) {
    const r = await h.send('Runtime.evaluate', { expression: probe, returnByValue: true })
    if (r?.result?.value === true) { h.readyFor = motifId; return }
    await delay(READY_POLL_MS)
  }
  throw new Error(`motif '${motifId}' never became ready (window.__motifRender undefined, document not complete, or wrong host page loaded)`)
}

async function doCapture(backend: Backend, a: CaptureArgs): Promise<string> {
  let h: Host
  try {
    h = await ensureHost(a.motifId, a.contentHash)
    await waitReady(h, a.motifId)
  } catch (e) {
    teardownHost()
    throw e
  }
  const duration = backend.motifCtxDurationS(a.motifId, a.propsJson)
  const props = JSON.parse(a.propsJson)
  const meta = { duration, width: a.width, height: a.height, fps: 30, settleRafs: a.settleRafs }
  const expr = `window.__motifRender(${JSON.stringify(a.tSec)}, ${JSON.stringify(props)}, ${JSON.stringify(meta)})`
  try {
    if (h.lastSize?.w !== a.width || h.lastSize?.h !== a.height) {
      await h.send('Emulation.setDeviceMetricsOverride', { width: a.width, height: a.height, deviceScaleFactor: 1, mobile: false })
      await h.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
      h.lastSize = { w: a.width, h: a.height }
    }
    const ev = await withTimeout(
      h.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      CAPTURE_TIMEOUT_MS, '__motifRender',
    )
    if (ev?.exceptionDetails) throw new Error('__motifRender threw: ' + JSON.stringify(ev.exceptionDetails))
    const shot = await withTimeout(h.send('Page.captureScreenshot', { format: 'png' }), CAPTURE_TIMEOUT_MS, 'captureScreenshot')
    if (!shot?.data) throw new Error('captureScreenshot returned no data')
    return shot.data as string // base64 PNG, no data: prefix
  } catch (e) {
    teardownHost() // wedged host: rebuild on next call
    throw e
  }
}

export function captureMotifFrameB64(backend: Backend, a: CaptureArgs): Promise<string> {
  const run = chain.then(() => doCapture(backend, a))
  // Keep the chain alive even if this capture rejects.
  chain = run.then(() => undefined, () => undefined)
  return run
}
