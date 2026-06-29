// Renderer-side (preload). contextIsolation is off for this POC, so `window` here
// IS the page window and we can draw straight to its canvas.
//
// `setSharedTextureReceiver` MUST be registered before main calls
// `sendSharedTexture`, so we register first, then signal readiness on DOM load.

const { sharedTexture } = require('electron')
const { ipcRenderer } = require('electron/renderer')

function drawAndVerify(frame) {
  const cv = document.getElementById('cv')
  const w = frame.displayWidth || frame.codedWidth
  const h = frame.displayHeight || frame.codedHeight
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  ctx.drawImage(frame, 0, 0)

  // After drawImage the canvas is RGBA regardless of the source format.
  let sample = null
  try {
    const px = ctx.getImageData(0, 0, w, h).data
    const at = (x, y) => {
      const i = (y * w + x) * 4
      return [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }
    const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    const fmt = String(frame.format || '').toUpperCase()
    if (fmt.includes('BGR') || fmt.includes('RGB')) {
      // BGRA checkerboard: cell (8,8) ~ orange [255,102,51], (40,8) ~ dark.
      const a = at(8, 8)
      const b = at(40, 8)
      const near = (c, r, g, bl) =>
        Math.abs(c[0] - r) < 40 && Math.abs(c[1] - g) < 40 && Math.abs(c[2] - bl) < 40
      sample = { mode: 'bgra', cellA: a, cellB: b, looksRight: near(a, 255, 102, 51) && near(b, 34, 34, 34) }
    } else {
      // NV12 luma bands: top half bright, bottom half dark.
      const top = at(8, 8)
      const bottom = at(8, h - 8)
      sample = {
        mode: 'nv12-luma',
        top,
        bottom,
        lumaTop: Math.round(luma(top)),
        lumaBottom: Math.round(luma(bottom)),
        looksRight: luma(top) > luma(bottom) + 60,
      }
    }
  } catch (e) {
    sample = { readbackError: String((e && e.message) || e) }
  }
  return { size: [w, h], format: frame.format, sample }
}

// ---------------------------------------------------------------------------
// Result 3 — streaming sync (renderer side). The SAME receiver fires once per
// streamed frame. For each: draw to canvas, read back the average luma of a
// center patch, and record {frameIndex, luma}. The producer's verification clip
// ramps luma monotonically with frame index, so on PASS the recorded luma must
// increase in lockstep with the (in-order, gapless) frame indices — proving no
// stale-frame reuse, no tearing, no duplicates.
// ---------------------------------------------------------------------------
// Frame indices arrive on their own IPC channel just before each send; queue
// them so the per-frame receiver can pair one up. We ALSO read the VideoFrame's
// own `timestamp` (set to frameIndex in main) as the authoritative source.
const indexQueue = []
ipcRenderer.on('poc-stream-frame-index', (_e, idx) => indexQueue.push(idx))

const streamLog = [] // [{ frameIndex, luma }]
let streamErrors = 0

// Average luma of a center patch — robust to YUV→RGB matrix; changes every frame
// on the ramp clip.
function sampleLuma(frame) {
  const cv = document.getElementById('cv')
  const w = frame.displayWidth || frame.codedWidth
  const h = frame.displayHeight || frame.codedHeight
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  ctx.drawImage(frame, 0, 0)
  const x0 = (w >> 2)
  const y0 = (h >> 2)
  const pw = Math.max(1, w >> 1)
  const ph = Math.max(1, h >> 1)
  const px = ctx.getImageData(x0, y0, pw, ph).data
  let sum = 0
  const n = px.length / 4
  for (let i = 0; i < px.length; i += 4) {
    sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
  }
  return Math.round(sum / n)
}

function streamReceiver(data) {
  const imported = data.importedSharedTexture
  try {
    const frame = imported.getVideoFrame()
    // VideoFrame.timestamp carries the frameIndex we tagged in main; fall back to
    // the IPC queue if the platform drops it.
    let frameIndex = typeof frame.timestamp === 'number' ? frame.timestamp : null
    if (frameIndex == null || Number.isNaN(frameIndex)) {
      frameIndex = indexQueue.length ? indexQueue.shift() : streamLog.length
    } else {
      // Keep the queue aligned even when we trust the timestamp.
      if (indexQueue.length) indexQueue.shift()
    }
    const luma = sampleLuma(frame)
    streamLog.push({ frameIndex, luma })
    frame.close()
    imported.release()
    const el = document.getElementById('log')
    if (el) el.textContent = `streaming… frame ${frameIndex} luma=${luma} (${streamLog.length} received)`
  } catch (e) {
    streamErrors++
    try { imported.release() } catch {}
    console.error('[poc] stream receiver threw:', e)
  }
}

// Single-frame receiver (Results 1 & 2): one import, draw + verify, report.
function singleReceiver(data) {
  const log = (m) => {
    const el = document.getElementById('log')
    if (el) el.textContent = m
  }
  try {
    const imported = data.importedSharedTexture
    const frame = imported.getVideoFrame()
    const result = {
      ok: true,
      frame: { codedWidth: frame.codedWidth, codedHeight: frame.codedHeight, format: frame.format },
      ...drawAndVerify(frame),
    }
    frame.close()
    imported.release()
    log(
      (result.sample && result.sample.looksRight)
        ? `✅ imported external ${result.frame.format} texture + displayed VideoFrame`
        : '⚠️ frame received but pixels look off — see console'
    )
    ipcRenderer.send('poc-result', result)
  } catch (e) {
    log('❌ receiver threw: ' + String((e && e.message) || e))
    ipcRenderer.send('poc-result', { ok: false, error: String((e && e.stack) || e) })
  }
}

// Preload runs in a Node context (nodeIntegration off, but preload always has
// `process`), so the mode env var is readable here.
const STREAM_MODE = process.env.POC_STREAM === '1'
sharedTexture.setSharedTextureReceiver(async (data) => {
  if (STREAM_MODE) streamReceiver(data)
  else singleReceiver(data)
})

// When the producer finishes, compute and report the streaming summary.
ipcRenderer.on('poc-stream-done', (_e, info) => {
  const received = streamLog.length
  // Ordering + advance: frame indices strictly increasing AND luma strictly
  // increasing across the received sequence (the ramp clip guarantees this).
  let orderedAndAdvancing = received > 0
  let gaps = 0
  let duplicates = 0
  const seen = new Set()
  for (let i = 0; i < streamLog.length; i++) {
    const { frameIndex, luma } = streamLog[i]
    if (seen.has(frameIndex)) duplicates++
    seen.add(frameIndex)
    if (i > 0) {
      const prev = streamLog[i - 1]
      if (frameIndex !== prev.frameIndex + 1) gaps++
      // Luma must advance with the ramp; allow equality only as a soft check
      // but a true stale-frame reuse would show a NON-advancing or backward luma.
      if (!(luma > prev.luma)) orderedAndAdvancing = false
      if (frameIndex <= prev.frameIndex) orderedAndAdvancing = false
    }
  }
  const summary = {
    sent: info.sent,
    received,
    fpsProducer: info.fps,
    busySpins: info.busySpins,
    gaps,
    duplicates,
    errors: streamErrors,
    orderedAndAdvancing,
    firstLuma: received ? streamLog[0].luma : null,
    lastLuma: received ? streamLog[received - 1].luma : null,
    lumaSamples: streamLog.slice(0, 5).concat(streamLog.slice(-3)),
  }
  const el = document.getElementById('log')
  if (el) el.textContent = `stream done: ${received}/${info.sent} frames, ordered=${orderedAndAdvancing}, gaps=${gaps}, dups=${duplicates}`
  ipcRenderer.send('poc-stream-summary', summary)
})

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('renderer-ready')
})

ipcRenderer.on('poc-error', (_e, msg) => {
  const el = document.getElementById('log')
  if (el) el.textContent = '❌ main process error:\n' + msg
})
