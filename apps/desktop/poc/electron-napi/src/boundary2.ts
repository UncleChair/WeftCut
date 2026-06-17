import { performance } from 'node:perf_hooks'
import { BrowserWindow } from 'electron'
import { createHost, captureFrame, HostHandle } from './capture'
import { pngDiff, hasAlpha } from './pngdiff'

export interface Boundary2Result {
  identical: boolean
  maxChannelDiff: number
  pctPixelsDiffering: number
  hasAlpha: boolean
  avgCaptureMs: number
  gpuRenderer: string
}

export async function runBoundary2(host: HostHandle): Promise<Boundary2Result> {
  // Determinism: same frozen t captured twice, in the opacity-animation window (t=0.35 < 0.8).
  const a1 = await captureFrame(host, 0.35)
  const a2 = await captureFrame(host, 0.35)
  const identical = a1.equals(a2)
  const diff = identical ? { maxChannelDiff: 0, pctPixelsDiffering: 0 } : pngDiff(a1, a2)
  const alpha = hasAlpha(a1)

  // Speed: warm 3, then time 20 distinct frames across the content window.
  for (let i = 0; i < 3; i++) await captureFrame(host, 0.1 + i * 0.05)
  const times: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await captureFrame(host, (i / 20) * 0.8)
    times.push(performance.now() - t0)
  }
  const avgCaptureMs = times.reduce((s, x) => s + x, 0) / times.length

  // Isolation: in the SAME process, does a normal window stay GPU-accelerated
  // while the offscreen capture window renders? Read its WebGL renderer string.
  const probe = new BrowserWindow({ show: false, webPreferences: { offscreen: false } })
  await probe.loadURL('data:text/html,<canvas id=c></canvas>')
  const gpuRenderer = (await probe.webContents.executeJavaScript(`
    (() => {
      const gl = document.getElementById('c').getContext('webgl');
      if (!gl) return 'no-webgl';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no-debug-ext';
    })()
  `)) as string
  probe.destroy()

  return {
    identical,
    maxChannelDiff: diff.maxChannelDiff,
    pctPixelsDiffering: diff.pctPixelsDiffering,
    hasAlpha: alpha,
    avgCaptureMs,
    gpuRenderer,
  }
}
