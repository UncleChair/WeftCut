// Electron main process for the sharedTexture-import POC.
//
// Flow (Electron's "managed" sharedTexture API):
//   1. renderer registers a receiver, then tells us it's ready
//   2. native code creates a D3D11 BGRA shared texture, hands us its NT handle
//   3. we importSharedTexture(handle) and sendSharedTexture(-> renderer)
//   4. when every reference is released, we free the native texture
//
// The ONE thing being tested: step 3 accepting a handle for a texture Chromium
// did not create.

const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron')
const path = require('node:path')
const native = require('./native')

// Which synthetic format to share. NV12 is the format ffmpeg d3d11va decode
// produces, so it's the one that matters for step 1b.
const FORMAT = (process.env.POC_FORMAT || 'nv12').toLowerCase()

// Required by importSharedTexture: codedSize + handle + pixelFormat. colorSpace /
// visibleRect / timestamp are optional but we provide them for fidelity.
function colorSpaceFor(format) {
  return format === 'nv12'
    ? { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'full' }
    : { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' }
}

function buildTextureInfo(tex) {
  return {
    codedSize: { width: tex.width, height: tex.height },
    visibleRect: { x: 0, y: 0, width: tex.width, height: tex.height },
    pixelFormat: tex.pixelFormat,
    colorSpace: colorSpaceFor(tex.pixelFormat),
    timestamp: 0,
    handle: { ntHandle: tex.handle },
  }
}

// ---------------------------------------------------------------------------
// Result 3 — streaming sync (POC_STREAM=1). Decode a multi-frame video into a
// POOL of reusable shared NV12 textures and pump them to the renderer one at a
// time: per-frame import / send / release, with the pool letting the producer
// fill frame N+1 while the renderer still holds frame N. Mirrors how Electron
// OSR streaming recycles textures.
// ---------------------------------------------------------------------------
const STREAM_COLOR_SPACE = {
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  range: 'full',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function streamVideo(win) {
  const video = process.env.POC_VIDEO
  if (!video) throw new Error('POC_STREAM=1 requires POC_VIDEO=<path>')
  const poolSize = Number(process.env.POC_POOL || 3)

  const info = native.pocOpenVideoStream(video, poolSize)
  console.log(
    `[poc] stream opened ${info.width}x${info.height}, pool=${info.poolSize}, src=${video}`
  )

  let sent = 0
  let busySpins = 0
  const t0 = Date.now()

  // Pump loop: keep asking native for the next frame. "busy" means every pool
  // slot is still held by the renderer (back-pressure) — yield and retry, do not
  // spin. "eof" ends the stream. Otherwise import + send the returned slot.
  for (;;) {
    const res = native.pocStreamNextFrame()
    if (res.status === 'eof') {
      console.log(`[poc] producer reached EOF after ${sent} frames sent`)
      break
    }
    if (res.status === 'busy') {
      busySpins++
      await sleep(2) // let the renderer drain + allReferencesReleased fire
      continue
    }

    const f = res.frame
    const textureInfo = {
      codedSize: { width: f.width, height: f.height },
      visibleRect: { x: 0, y: 0, width: f.width, height: f.height },
      pixelFormat: 'nv12',
      colorSpace: STREAM_COLOR_SPACE,
      timestamp: f.frameIndex,
      handle: { ntHandle: f.handle },
    }

    const imported = sharedTexture.importSharedTexture({
      textureInfo,
      // Frees the pool slot once BOTH main and renderer references are gone, so
      // the producer can reuse this texture for a later frame.
      allReferencesReleased: () => native.pocFreeSlot(f.slot),
    })

    // Tell the renderer which logical frame index this send carries, so its
    // summary can verify ordering independent of receive timing.
    win.webContents.send('poc-stream-frame-index', f.frameIndex)

    await sharedTexture.sendSharedTexture({
      frame: win.webContents.mainFrame,
      importedSharedTexture: imported,
    })
    // Drop main's reference immediately; the renderer holds one until it draws.
    imported.release()
    sent++
  }

  const dt = (Date.now() - t0) / 1000
  const fps = dt > 0 ? (sent / dt).toFixed(1) : 'n/a'
  console.log(
    `[poc] stream pump done: ${sent} frames sent in ${dt.toFixed(2)}s (${fps} fps), busySpins=${busySpins}`
  )
  native.pocCloseVideoStream()

  // Tell the renderer the stream is finished; it replies with its summary.
  win.webContents.send('poc-stream-done', { sent, fps, busySpins })
}

// ---------------------------------------------------------------------------
// Result 4 — persistent import / zero per-frame IPC (POC_PERSIST=1).
//
// Import + send each pool texture exactly ONCE, then overwrite its content over
// time WITHOUT re-import/re-send, and have the renderer pull getVideoFrame() on
// its own timer. The binary question: does a persistent import reflect the
// producer's later writes (PASS — zero per-frame texture IPC is possible), or
// does it freeze at the first frame (FAIL — per-frame re-import is mandatory)?
//
// import-count and send-count are tracked here; on PASS they MUST equal poolSize
// (one-time, not per-frame), which is the other half of the proof.
// ---------------------------------------------------------------------------
async function persistVideo(win) {
  const video = process.env.POC_VIDEO
  if (!video) throw new Error('POC_PERSIST=1 requires POC_VIDEO=<path>')
  const poolSize = Number(process.env.POC_POOL || 1)
  // Cap on frames the producer writes (decode order), so the run is bounded even
  // for long clips; the verification ramp clip has 60 frames.
  const maxFrames = Number(process.env.POC_FRAMES || 60)
  // Producer write cadence (ms). The renderer pulls on its own rAF loop.
  const writeIntervalMs = Number(process.env.POC_WRITE_MS || 16)

  const info = native.pocOpenVideoStream(video, poolSize)
  console.log(
    `[poc] persist opened ${info.width}x${info.height}, pool=${info.poolSize}, src=${video}`
  )

  let importCount = 0
  let sendCount = 0
  let allRefsReleasedFires = 0

  // ---- ONE-TIME import + send per pool slot ----
  // Keep every imported alive in this array for the whole run so its
  // allReferencesReleased never fires (main always holds a reference). The
  // renderer also keeps its reference (it never calls imported.release() in
  // persist mode). So the underlying texture stays alive and reusable.
  const importedBySlot = []
  for (let slot = 0; slot < info.poolSize; slot++) {
    const h = native.pocPersistSlotHandle(slot)
    const textureInfo = {
      codedSize: { width: h.width, height: h.height },
      visibleRect: { x: 0, y: 0, width: h.width, height: h.height },
      pixelFormat: 'nv12',
      colorSpace: STREAM_COLOR_SPACE,
      timestamp: 0,
      handle: { ntHandle: h.handle },
    }
    const imported = sharedTexture.importSharedTexture({
      textureInfo,
      // Should basically never fire in this mode: main holds the imported for the
      // whole run and the renderer never releases its copy. Count it if it does —
      // that would itself be evidence the persistent-import assumption is shaky.
      allReferencesReleased: () => {
        allRefsReleasedFires++
        console.log(`[poc] UNEXPECTED allReferencesReleased for slot ${slot}`)
      },
    })
    importCount++
    importedBySlot[slot] = imported

    // Tell the renderer which slot this send carries, in send order, so it can
    // assign the received imported to a slot index for its per-slot pull loop.
    win.webContents.send('poc-persist-slot', slot)

    await sharedTexture.sendSharedTexture({
      frame: win.webContents.mainFrame,
      importedSharedTexture: imported,
    })
    sendCount++
    // NOTE: deliberately DO NOT call imported.release() — persistent import.
  }
  console.log(`[poc] persist setup done: importCount=${importCount}, sendCount=${sendCount} (poolSize=${info.poolSize})`)

  // Let the renderer register its persistent imports and start its pull loop.
  win.webContents.send('poc-persist-go', { poolSize: info.poolSize })
  await sleep(200)

  // ---- Producer loop: overwrite the textures in place, round-robin, NO re-import/re-send ----
  let written = 0
  const t0 = Date.now()
  for (;;) {
    const slot = written % info.poolSize
    const res = native.pocPersistWriteNext(slot)
    if (res.status === 'eof') {
      console.log(`[poc] producer reached EOF after writing ${written} frames`)
      break
    }
    written++
    // Poke the renderer with the just-written frame index + slot (for correlation
    // only; the renderer's pull loop is independent of this poke).
    win.webContents.send('poc-persist-wrote', { slot, frameIndex: res.frameIndex })
    if (written >= maxFrames) {
      console.log(`[poc] producer hit frame cap ${maxFrames}`)
      break
    }
    await sleep(writeIntervalMs)
  }
  const dt = (Date.now() - t0) / 1000
  console.log(
    `[poc] persist producer done: wrote ${written} frames in ${dt.toFixed(2)}s; importCount=${importCount}, sendCount=${sendCount}, allRefsReleasedFires=${allRefsReleasedFires}`
  )

  // Give the renderer a moment to keep pulling the final content, then ask for
  // its summary.
  await sleep(500)
  win.webContents.send('poc-persist-done', {
    written,
    poolSize: info.poolSize,
    importCount,
    sendCount,
    allRefsReleasedFires,
  })
}

async function pushTexture(win) {
  const video = process.env.POC_VIDEO
  const zeroCopy = process.env.POC_ZEROCOPY === '1'
  const tex = video
    ? zeroCopy
      ? native.pocCreateTextureFromVideoZerocopy(video)
      : native.pocCreateTextureFromVideo(video)
    : native.pocCreateSyntheticTexture(FORMAT)
  console.log(
    `[poc] native ${tex.pixelFormat} ${tex.width}x${tex.height} texture id=${tex.id} adapter="${tex.adapter}"` +
      (video ? ` (${zeroCopy ? 'ZERO-COPY ' : ''}decoded from ${video})` : '')
  )

  const imported = sharedTexture.importSharedTexture({
    textureInfo: buildTextureInfo(tex),
    allReferencesReleased: () => {
      console.log(`[poc] allReferencesReleased -> free native id=${tex.id}`)
      native.pocReleaseTexture(tex.id)
    },
  })
  console.log(`[poc] importSharedTexture OK, textureId=${imported.textureId}`)

  await sharedTexture.sendSharedTexture({
    frame: win.webContents.mainFrame,
    importedSharedTexture: imported,
  })
  console.log('[poc] sendSharedTexture resolved (renderer now holds a reference)')

  // Drop the main-process reference; the renderer keeps the resource alive until
  // it finishes drawing and releases its own.
  imported.release()
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 340,
    height: 420,
    show: true,
    title: 'sharedTexture import POC',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Throwaway POC: relax isolation so the preload can draw straight to the
      // page canvas. Do NOT copy this into the real app.
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(__dirname, 'index.html'))

  const streaming = process.env.POC_STREAM === '1'
  const persistent = process.env.POC_PERSIST === '1'

  ipcMain.on('renderer-ready', async () => {
    try {
      if (persistent) {
        await persistVideo(win)
      } else if (streaming) {
        await streamVideo(win)
      } else {
        await pushTexture(win)
      }
    } catch (e) {
      const msg = String((e && e.stack) || e)
      console.error('[poc] FAILED:', msg)
      win.webContents.send('poc-error', msg)
    }
  })

  ipcMain.on('poc-result', (_e, result) => {
    console.log('[poc] ===== RENDERER RESULT =====')
    console.log(JSON.stringify(result, null, 2))
    // Keep the window up briefly, then exit so the run is non-interactive.
    setTimeout(() => app.quit(), 2500)
  })

  ipcMain.on('poc-stream-summary', (_e, summary) => {
    console.log('[poc] ===== STREAM SUMMARY =====')
    console.log(JSON.stringify(summary, null, 2))
    const pass =
      summary.received === summary.sent &&
      summary.orderedAndAdvancing &&
      summary.gaps === 0 &&
      summary.duplicates === 0 &&
      summary.errors === 0 &&
      summary.received >= 60
    console.log(`[poc] STREAM VERDICT: ${pass ? 'PASS ✅' : 'FAIL ❌'}`)
    setTimeout(() => app.quit(), 1500)
  })

  ipcMain.on('poc-persist-summary', (_e, summary) => {
    console.log('[poc] ===== PERSIST SUMMARY =====')
    console.log(JSON.stringify(summary, null, 2))
    // PASS = (a) import/send were ONE-TIME (== poolSize, not per-frame) AND (b) the
    // renderer's repeated getVideoFrame() on the persistent import observed luma
    // that ADVANCED over the run (clearly not frozen at the first frame). FAIL =
    // luma frozen → persistent import does not reflect producer writes → per-frame
    // re-import is mandatory.
    const oneTimeImports =
      summary.importCount === summary.poolSize && summary.sendCount === summary.poolSize
    const advanced = summary.advanced === true
    const pass = oneTimeImports && advanced && summary.pullErrors === 0
    console.log(
      `[poc] PERSIST one-time import/send: ${oneTimeImports} (import=${summary.importCount}, send=${summary.sendCount}, pool=${summary.poolSize})`
    )
    console.log(
      `[poc] PERSIST luma advanced: ${advanced} (distinct=${summary.distinctLuma}, min=${summary.minLuma}, max=${summary.maxLuma}, firstPull=${summary.firstLuma}, lastPull=${summary.lastLuma}, pulls=${summary.totalPulls})`
    )
    console.log(
      `[poc] PERSIST tearing check: backwardStepsMidRun=${summary.backwardStepsMidRun} (the tearing signal; 0 ⇒ no torn/reordered reads), backwardStepsTotal=${summary.backwardSteps} incl. one benign startup re-align, maxBackwardDrop=${summary.maxBackwardDrop}`
    )
    console.log(
      `[poc] PERSIST VERDICT: ${pass ? 'PASS ✅ (persistent import reflects updates → zero per-frame texture IPC)' : 'FAIL ❌ (persistent import stale/frozen → per-frame re-import required)'}`
    )
    setTimeout(() => app.quit(), 1500)
  })

  // Watchdog: never hang headless. Streaming + persistent runs decode many frames
  // and round-trip, so give them more headroom than the single-frame probe.
  setTimeout(
    () => {
      console.log('[poc] watchdog timeout — quitting')
      app.quit()
    },
    streaming || persistent ? 60000 : 12000
  )
})

app.on('window-all-closed', () => app.quit())
