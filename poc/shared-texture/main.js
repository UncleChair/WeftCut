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

  ipcMain.on('renderer-ready', async () => {
    try {
      if (streaming) {
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

  // Watchdog: never hang headless. Streaming runs longer (decode + per-frame
  // round-trips), so give it more headroom than the single-frame probe.
  setTimeout(
    () => {
      console.log('[poc] watchdog timeout — quitting')
      app.quit()
    },
    streaming ? 60000 : 12000
  )
})

app.on('window-all-closed', () => app.quit())
