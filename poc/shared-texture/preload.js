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

// ---------------------------------------------------------------------------
// Result 4 — persistent import / zero per-frame IPC (renderer side).
//
// We receive each pool texture's import EXACTLY ONCE (in send order), store it,
// and NEVER release it. Then on a self-paced rAF loop we call getVideoFrame() on
// each stored persistent import and sample its center-patch luma. The producer
// (main) overwrites the SAME underlying textures over time without re-importing.
// If getVideoFrame() reflects the new content, luma ADVANCES over the run (PASS);
// if it freezes at the first frame, luma stays flat (FAIL).
// ---------------------------------------------------------------------------
const persistImports = [] // slot index -> SharedTextureImported (kept alive)
const persistSlotQueue = [] // slot indices announced by main, in send order
let persistPulls = [] // [{ tMs, slot, luma }]
let persistPullErrors = 0
let persistPulling = false
let persistT0 = 0

ipcRenderer.on('poc-persist-slot', (_e, slot) => persistSlotQueue.push(slot))

function persistReceiver(data) {
  const imported = data.importedSharedTexture
  // Assign this received import to the slot index main announced just before the
  // send (FIFO); fall back to arrival order if the queue is empty.
  const slot = persistSlotQueue.length ? persistSlotQueue.shift() : persistImports.length
  persistImports[slot] = imported // KEEP alive — do NOT release.
  const el = document.getElementById('log')
  if (el) el.textContent = `persist: imported slot ${slot} (${persistImports.filter(Boolean).length} held)`
}

// One pull pass: for each persistent import, getVideoFrame(), sample luma, close
// the frame but KEEP the imported. Records a time series for the advance check.
function persistPullOnce() {
  for (let slot = 0; slot < persistImports.length; slot++) {
    const imported = persistImports[slot]
    if (!imported) continue
    try {
      const frame = imported.getVideoFrame()
      const luma = sampleLuma(frame)
      frame.close() // close the per-pull VideoFrame; the imported stays alive.
      persistPulls.push({ tMs: Math.round(performance.now() - persistT0), slot, luma })
    } catch (e) {
      persistPullErrors++
      console.error('[poc] persist pull threw:', e)
    }
  }
}

function persistPullLoop() {
  if (!persistPulling) return
  persistPullOnce()
  requestAnimationFrame(persistPullLoop)
}

ipcRenderer.on('poc-persist-go', () => {
  persistT0 = performance.now()
  persistPulling = true
  requestAnimationFrame(persistPullLoop)
})

ipcRenderer.on('poc-persist-done', (_e, info) => {
  persistPulling = false
  // A few final pulls to capture the last written content, then summarise.
  persistPullOnce()
  persistPullOnce()

  const lumas = persistPulls.map((p) => p.luma)
  const distinct = new Set(lumas)
  const minLuma = lumas.length ? Math.min(...lumas) : null
  const maxLuma = lumas.length ? Math.max(...lumas) : null
  const firstLuma = lumas.length ? lumas[0] : null
  const lastLuma = lumas.length ? lumas[lumas.length - 1] : null
  // ADVANCED = the persistent import clearly reflected updated content: many
  // distinct luma values AND a clear rise from the first sample (the ramp clip
  // goes 20→235). A frozen/stale import would show 1 distinct value, max≈min.
  const advanced =
    distinct.size >= 3 && maxLuma != null && minLuma != null && maxLuma - minLuma >= 40

  // Monotonicity check — PER SLOT. The producer writes luma strictly upward into
  // each slot it owns; a clean read of a slot's persistent import therefore never
  // steps BACKWARD between consecutive pulls OF THAT SLOT. A backward step mid-run
  // means a torn / re-ordered read of that shared texture (the soft tearing
  // check). Must be per-slot: with poolSize>1 the producer writes slots
  // round-robin, so they are a frame apart at any instant — comparing across
  // slots would show spurious "backward" steps that are just the pool offset, not
  // tearing.
  //
  // The pull loop (rAF) starts ~independently of the producer, so a slot's FIRST
  // few pulls can catch it mid-ramp (the producer ran a few frames during setup)
  // then snap back to the true ramp start ONCE. That single startup re-alignment
  // per slot is benign; backward steps AFTER startup are the real tearing signal.
  const startupPulls = 12
  let backwardSteps = 0 // all backward steps across all slots (incl. startup)
  let maxBackwardDrop = 0
  let backwardStepsMidRun = 0 // per-slot backward steps after startup — tearing signal
  for (let slot = 0; slot < persistImports.length; slot++) {
    if (!persistImports[slot]) continue
    const slotPulls = persistPulls.filter((p) => p.slot === slot)
    for (let i = 1; i < slotPulls.length; i++) {
      const drop = slotPulls[i - 1].luma - slotPulls[i].luma
      if (drop > 1) {
        backwardSteps++
        if (drop > maxBackwardDrop) maxBackwardDrop = drop
        if (i >= startupPulls) backwardStepsMidRun++
      }
    }
  }

  const summary = {
    written: info.written,
    poolSize: info.poolSize,
    importCount: info.importCount,
    sendCount: info.sendCount,
    allRefsReleasedFires: info.allRefsReleasedFires,
    totalPulls: persistPulls.length,
    pullErrors: persistPullErrors,
    distinctLuma: distinct.size,
    minLuma,
    maxLuma,
    firstLuma,
    lastLuma,
    advanced,
    backwardSteps,
    backwardStepsMidRun,
    maxBackwardDrop,
    // Down-sampled trajectory (~14 points across the whole run) so the log shows
    // the advance, not just head+tail.
    lumaSeries: persistPulls.filter(
      (_p, i) => i % Math.max(1, Math.floor(persistPulls.length / 14)) === 0
    ),
    // Full per-pull series, gated on POC_PERSIST_DUMP=1, for offline trajectory /
    // tearing analysis (kept out of the default summary to keep logs readable).
    fullSeries: process.env.POC_PERSIST_DUMP === '1' ? persistPulls : undefined,
  }
  const el = document.getElementById('log')
  if (el)
    el.textContent = `persist done: ${persistPulls.length} pulls, distinctLuma=${distinct.size}, luma ${minLuma}→${maxLuma}, advanced=${advanced}`
  ipcRenderer.send('poc-persist-summary', summary)
})

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
const PERSIST_MODE = process.env.POC_PERSIST === '1'
sharedTexture.setSharedTextureReceiver(async (data) => {
  if (PERSIST_MODE) persistReceiver(data)
  else if (STREAM_MODE) streamReceiver(data)
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
