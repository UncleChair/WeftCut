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

// ---------------------------------------------------------------------------
// Result 5 — renderer color paths (POC_COLOR=1).
//
// The gap: every prior result verified pixels ONLY via 2D `drawImage` +
// `getImageData`, which honors `VideoFrame.colorSpace`. WeftCut's real renderer
// uploads to WebGPU/Pixi, and a known WeftCut finding is that Pixi v8's
// `device.queue.copyExternalImageToTexture({source: videoFrame})` IGNORES the
// frame's colorSpace and always converts with the BT.709 matrix — so a correctly
// BT.601-tagged frame mis-converts. UNVERIFIED for our shared NV12 textures: does
// the spec video path, `device.importExternalTexture({source})` +
// `texture_external` + `textureSampleBaseClampToEdge`, honor BT.601?
//
// We decode ONE frame of a SATURATED, BT.601-tagged clip via the existing
// zero-copy NV12 path, import it tagged BT.601, and ingest the SAME content three
// ways in the renderer — (1) 2D drawImage, (2) copyExternalImageToTexture,
// (3) importExternalTexture — reading back the center-patch RGB of each and
// comparing to the known source color. As a control we ALSO import the same frame
// tagged BT.709 (deliberately wrong tag) to confirm the matrix is what moves the
// numbers.
//
// `colorSpaceFor`/`STREAM_COLOR_SPACE` hardcode bt709; this mode drives 601/709
// explicitly via the textureInfo.colorSpace below — that is the whole point.
// ---------------------------------------------------------------------------
const COLOR_SPACE_601 = {
  // The matrix (smpte170m) is what drives YUV->RGB; range:'limited' matches the
  // clip's color_range=tv. primaries/transfer don't affect the YUV->RGB matrix.
  primaries: 'smpte170m',
  transfer: 'smpte170m',
  matrix: 'smpte170m',
  range: 'limited',
}
const COLOR_SPACE_709 = {
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  range: 'limited',
}

async function colorTest(win) {
  const video = process.env.POC_VIDEO
  if (!video) throw new Error('POC_COLOR=1 requires POC_VIDEO=<path>')

  // Decode the SAME first frame twice into two independent shared NV12 textures,
  // so we can import one tagged 601 (the honest tag) and one tagged 709 (the
  // deliberately-wrong control) without any double-import-of-one-handle subtlety.
  // The clip is solid color, so both decodes are byte-identical content.
  const variants = [
    { tag: 'bt601', colorSpace: COLOR_SPACE_601 },
    { tag: 'bt709', colorSpace: COLOR_SPACE_709 },
  ]

  for (const v of variants) {
    const tex = native.pocCreateTextureFromVideoZerocopy(video)
    console.log(
      `[poc] color: decoded zero-copy ${tex.pixelFormat} ${tex.width}x${tex.height} (tag=${v.tag}, matrix=${v.colorSpace.matrix}, range=${v.colorSpace.range})`
    )
    const textureInfo = {
      codedSize: { width: tex.width, height: tex.height },
      visibleRect: { x: 0, y: 0, width: tex.width, height: tex.height },
      // Adapt to what native shared: 'nv12' for 8-bit, 'p010le' for 10-bit sources.
      pixelFormat: tex.pixelFormat,
      colorSpace: v.colorSpace,
      timestamp: 0,
      handle: { ntHandle: tex.handle },
    }
    const imported = sharedTexture.importSharedTexture({
      textureInfo,
      allReferencesReleased: () => native.pocReleaseTexture(tex.id),
    })
    // Tell the renderer which tag this send carries so it labels its readback.
    win.webContents.send('poc-color-tag', v.tag)
    await sharedTexture.sendSharedTexture({
      frame: win.webContents.mainFrame,
      importedSharedTexture: imported,
    })
    imported.release() // renderer holds its own ref until it finishes the 3 paths
    // Wait for the renderer to finish all three ingestion paths for THIS variant
    // before sending the next (keeps the receiver one-variant-at-a-time, since
    // WebGPU readback is async).
    await new Promise((resolve) => ipcMain.once(`poc-color-variant-done-${v.tag}`, resolve))
  }

  win.webContents.send('poc-color-done')
}

// ---------------------------------------------------------------------------
// Result 6 — native NV12→BGRA convert (color-correct zero-copy) (POC_BGRA=1).
//
// Result 5 proved feeding raw NV12 into WebGPU mis-colors BT.601 sources
// ([58,217,38] vs the [20,220,40] that 2D drawImage produces). The fix under
// test here: convert NV12→BGRA in NATIVE (a D3D11 pixel shader on ffmpeg's
// device, BT.601 limited-range matrix, no primaries remap) and share an
// already-RGB BGRA texture. Then WebGPU has no YUV→RGB to mishandle.
//
// Two textures from the SAME solid clip, in the SAME run:
//   - refDraw      = 2D drawImage of the RAW NV12 frame (601-tagged) — WeftCut's
//                    existing-pipeline reference (~[20,220,40]).
//   - bgraViaWebGPU= copyExternalImageToTexture readback of the NATIVE-CONVERTED
//                    BGRA texture (the path that was WRONG for raw NV12).
// PASS = bgraViaWebGPU matches refDraw within +/-8/channel (color-correct AND
// consistent with the pipeline AND stable through WebGPU), and is clearly NOT
// the broken ~[58,217,38].
// ---------------------------------------------------------------------------
// BGRA is already RGB in the working/sRGB space — no YUV→RGB matrix for the
// importer to apply. range:'full' because the shader output spans 0..255.
const COLOR_SPACE_BGRA_SRGB = {
  primaries: 'bt709',
  transfer: 'srgb',
  matrix: 'rgb',
  range: 'full',
}

async function bgraTest(win) {
  const video = process.env.POC_VIDEO
  if (!video) throw new Error('POC_BGRA=1 requires POC_VIDEO=<path>')

  // Source colorimetry. Default 601 (the motivating clip). For a 709 clip set
  // POC_BGRA_MATRIX=709 so BOTH the reference NV12 tag AND the native convert
  // shader honor 709 — the matrix MUST match the source (Result 6 finding).
  const matrix = (process.env.POC_BGRA_MATRIX || '601').toLowerCase()
  const refColorSpace = matrix === '709' ? COLOR_SPACE_709 : COLOR_SPACE_601
  console.log(`[poc] bgra: source matrix = ${matrix}`)

  // variant 'ref'  → raw NV12, tagged to match the source (the reference path).
  // variant 'bgra' → native-converted BGRA (same matrix), tagged sRGB/full RGB.
  const variants = [
    {
      tag: 'ref',
      make: () => native.pocCreateTextureFromVideoZerocopy(video),
      pixelFormat: 'nv12',
      colorSpace: refColorSpace,
    },
    {
      tag: 'bgra',
      make: () => native.pocCreateBgraFromVideoZerocopy(video, matrix),
      pixelFormat: 'bgra',
      colorSpace: COLOR_SPACE_BGRA_SRGB,
    },
  ]

  for (const v of variants) {
    const tex = v.make()
    console.log(
      `[poc] bgra: ${v.tag} -> ${tex.pixelFormat} ${tex.width}x${tex.height} (matrix=${v.colorSpace.matrix}, range=${v.colorSpace.range}, adapter=${tex.adapter})`
    )
    const textureInfo = {
      codedSize: { width: tex.width, height: tex.height },
      visibleRect: { x: 0, y: 0, width: tex.width, height: tex.height },
      pixelFormat: v.pixelFormat,
      colorSpace: v.colorSpace,
      timestamp: 0,
      handle: { ntHandle: tex.handle },
    }
    const imported = sharedTexture.importSharedTexture({
      textureInfo,
      allReferencesReleased: () => native.pocReleaseTexture(tex.id),
    })
    win.webContents.send('poc-bgra-tag', v.tag)
    await sharedTexture.sendSharedTexture({
      frame: win.webContents.mainFrame,
      importedSharedTexture: imported,
    })
    imported.release()
    await new Promise((resolve) => ipcMain.once(`poc-bgra-variant-done-${v.tag}`, resolve))
  }

  win.webContents.send('poc-bgra-done')
}

// ---------------------------------------------------------------------------
// Result 7 — Claim B: createImageBitmap coherence under consume-ack
// (POC_CIB_PERSIST=1).
//
// The re-baselined design (INTEGRATION-DESIGN.md §3.3, choice 乙) keeps the
// Result-4 persistent import (import+send each slot ONCE) but, instead of feeding
// the VideoFrame straight to WebGPU, SNAPSHOTS it with the ASYNC createImageBitmap
// before the slot may be reused. Result 4 only proved persistent-import coherence
// with a SYNCHRONOUS readback; the async snapshot is the new gap. The chosen
// guard is an explicit consume-ack: the producer overwrites a slot only after the
// renderer has acked that its createImageBitmap finished reading the prior write.
//
// This mode validates that discipline: per slot, write -> frameReady -> renderer
// getVideoFrame()+await createImageBitmap()+sample -> ack -> (slot reusable). With
// pool>=2 it pipelines (write slot B while the renderer snapshots slot A), which is
// the real v1 model. The ramp clip lets the renderer check each snapshot caught the
// CORRECT frame (measured luma == expected ramp luma for that frameIndex) and that
// no per-slot read stepped backward (tearing).
// ---------------------------------------------------------------------------
const cibImportsMain = [] // keep main-side persistent imports alive for the run

async function cibPersistTest(win) {
  const video = process.env.POC_VIDEO
  if (!video) throw new Error('POC_CIB_PERSIST=1 requires POC_VIDEO=<path>')
  const poolSize = Number(process.env.POC_POOL || 2)
  const maxFrames = Number(process.env.POC_FRAMES || 60)

  const info = native.pocOpenVideoStream(video, poolSize)
  console.log(
    `[poc] cib-persist opened ${info.width}x${info.height}, pool=${info.poolSize}, src=${video}, maxFrames=${maxFrames}`
  )

  // ---- ONE-TIME persistent import + send per slot (Result 4) ----
  let importCount = 0
  let sendCount = 0
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
      allReferencesReleased: () => {},
    })
    importCount++
    cibImportsMain[slot] = imported // keep alive — persistent import
    win.webContents.send('poc-cib-slot', slot)
    await sharedTexture.sendSharedTexture({
      frame: win.webContents.mainFrame,
      importedSharedTexture: imported,
    })
    sendCount++
  }
  console.log(`[poc] cib-persist setup: import=${importCount}, send=${sendCount} (pool=${info.poolSize})`)

  win.webContents.send('poc-cib-go', { poolSize: info.poolSize })
  await sleep(150)

  // ---- consume-ack producer: only overwrite a slot whose prior frame the
  // renderer has acked (createImageBitmap done). With pool>=2 this pipelines. ----
  const inFlight = new Set()
  let written = 0
  let eof = false
  const t0 = Date.now()

  return new Promise((resolve) => {
    const finalize = () => {
      const dt = (Date.now() - t0) / 1000
      console.log(`[poc] cib-persist producer done: wrote ${written} frames in ${dt.toFixed(2)}s`)
      ipcMain.removeListener('poc-cib-ack', onAck)
      native.pocCloseVideoStream()
      win.webContents.send('poc-cib-done', {
        written,
        poolSize: info.poolSize,
        importCount,
        sendCount,
      })
      resolve()
    }
    const tryProduce = () => {
      while (!eof && written < maxFrames && inFlight.size < info.poolSize) {
        let slot = -1
        for (let s = 0; s < info.poolSize; s++) {
          if (!inFlight.has(s)) { slot = s; break }
        }
        if (slot < 0) break
        const res = native.pocPersistWriteNext(slot)
        if (res.status === 'eof') { eof = true; break }
        inFlight.add(slot)
        written++
        win.webContents.send('poc-cib-frame-ready', { slot, frameIndex: res.frameIndex })
      }
      if ((eof || written >= maxFrames) && inFlight.size === 0) finalize()
    }
    const onAck = (_e, { slot }) => {
      inFlight.delete(slot)
      tryProduce()
    }
    ipcMain.on('poc-cib-ack', onAck)
    tryProduce()
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
  const colorMode = process.env.POC_COLOR === '1'
  const bgraMode = process.env.POC_BGRA === '1'
  const cibPersistMode = process.env.POC_CIB_PERSIST === '1'

  ipcMain.on('renderer-ready', async () => {
    try {
      if (cibPersistMode) {
        await cibPersistTest(win)
      } else if (bgraMode) {
        await bgraTest(win)
      } else if (colorMode) {
        await colorTest(win)
      } else if (persistent) {
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

  // Result 7 — Claim B: createImageBitmap coherence under consume-ack. The
  // renderer reports, after the producer's consume-ack-gated run, whether every
  // async createImageBitmap snapshot caught the CORRECT frame (measured luma ==
  // expected ramp luma) with no per-slot backward step (tearing).
  ipcMain.on('poc-cib-summary', (_e, s) => {
    console.log('[poc] ===== RESULT 7 (Claim B) — createImageBitmap COHERENCE: SUMMARY =====')
    console.log(JSON.stringify(s, null, 2))
    const oneTime = s.importCount === s.poolSize && s.sendCount === s.poolSize
    const allSnapped = s.snapshotsTaken >= s.framesRequested && s.framesRequested >= 30
    const correctFrames = s.maxErrVsExpected != null && s.maxErrVsExpected <= 8
    const noTearing = s.backwardSteps === 0
    const noErrors = s.cibErrors === 0
    const pass = oneTime && allSnapped && correctFrames && noTearing && noErrors
    console.log(`  one-time import/send: ${oneTime} (import=${s.importCount}, send=${s.sendCount}, pool=${s.poolSize})`)
    console.log(`  every frame snapshotted: ${allSnapped} (snapshots=${s.snapshotsTaken}/${s.framesRequested})`)
    console.log(`  snapshots caught CORRECT frame: ${correctFrames} (maxErrVsExpected=${s.maxErrVsExpected}, meanErr=${s.meanErrVsExpected}, tol<=8)`)
    console.log(`  no tearing (per-slot backward steps): ${noTearing} (backwardSteps=${s.backwardSteps})`)
    console.log(`  no snapshot errors: ${noErrors} (cibErrors=${s.cibErrors})`)
    console.log(
      `[poc] RESULT 7 (Claim B) VERDICT: ${pass ? 'PASS ✅ (persistent import + in-place overwrite + async createImageBitmap under consume-ack is coherent — no stale/torn reads)' : 'FAIL ❌ (see numbers above)'}`
    )
    setTimeout(() => app.quit(), 1500)
  })

  // Result 5 — renderer color paths. The renderer reports, per import tag (601 /
  // 709), the measured center-patch RGB for each of the three ingestion paths.
  // EXPECTED (correct, BT.601 honored): RGB ~ (20,220,40); WRONG (709 matrix on
  // the 601-tagged YUV): RGB ~ (5,190,35) — the green channel is the discriminator
  // (~218 correct vs ~190 wrong). Tolerance ±12 per channel absorbs H.264 + 4:2:0
  // rounding.
  const COLOR_EXPECTED = { bt601: [20, 220, 40] }
  const colorResults = {}
  ipcMain.on('poc-color-result', (_e, r) => {
    console.log(`[poc] ===== COLOR RESULT (tag=${r.tag}) =====`)
    console.log(JSON.stringify(r, null, 2))
    colorResults[r.tag] = r
    ipcMain.emit(`poc-color-variant-done-${r.tag}`)
  })
  ipcMain.on('poc-color-summary-request', () => {
    console.log('[poc] ===== RESULT 5 — RENDERER COLOR PATHS: VERDICT =====')
    const exp = COLOR_EXPECTED.bt601
    const tol = 12
    const r601 = colorResults.bt601
    const r709 = colorResults.bt709
    const err = (m) => (m ? [m[0] - exp[0], m[1] - exp[1], m[2] - exp[2]] : null)
    const maxAbs = (e) => (e ? Math.max(Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2])) : null)
    const verdict = (m) => {
      const e = err(m)
      const ma = maxAbs(e)
      return { measured: m, errVsExpected: e, maxAbsErr: ma, status: ma != null && ma <= tol ? 'CORRECT' : 'WRONG' }
    }
    if (r601) {
      const paths = {
        drawImage_2d: verdict(r601.drawImage),
        copyExternalImageToTexture: verdict(r601.copyExternal),
        importExternalTexture: verdict(r601.importExternal),
        createImageBitmap: verdict(r601.createImageBitmap),
      }
      console.log(`Source RGB fed to encoder: (20,220,40); ffmpeg 601-honoring decode ground truth: ~(19,218,40)`)
      console.log(`Expected CORRECT readback (BT.601): [${exp}], tolerance +/-${tol}/channel`)
      console.log(`Reference WRONG-if-709 readback: ~[5,190,35]`)
      console.log('--- BT.601-tagged import (the honest tag) ---')
      for (const [name, v] of Object.entries(paths)) {
        console.log(`  ${name}: measured=[${v.measured}] err=[${v.errVsExpected}] maxAbsErr=${v.maxAbsErr} => ${v.status}`)
      }
      // Result 7, Claim A: the re-baselined design ships createImageBitmap. It
      // PASSES iff createImageBitmap is CORRECT (matches the drawImage reference /
      // source color within tolerance) — i.e. it honors the BT.601 tag, unlike the
      // WebGPU paths. This is the claim Result 5 left as an assertion-by-analogy.
      const cibV = paths.createImageBitmap
      console.log(
        `[poc] RESULT 7 (Claim A — createImageBitmap color, BT.601): ${cibV.status === 'CORRECT' ? 'PASS ✅' : 'FAIL ❌'} (measured=[${cibV.measured}], maxAbsErr=${cibV.maxAbsErr})`
      )
      if (r601.rgbaControl) {
        const c = r601.rgbaControl
        const ce = [c.measured[0] - c.known[0], c.measured[1] - c.known[1], c.measured[2] - c.known[2]]
        const cma = Math.max(Math.abs(ce[0]), Math.abs(ce[1]), Math.abs(ce[2]))
        console.log(
          `  [control] known-sRGB through same WebGPU readback: known=[${c.known}] measured=[${c.measured}] maxAbsErr=${cma} => ${cma <= tol ? 'readback CLEAN' : 'readback ITSELF skews'}`
        )
      } else if (r601.rgbaControlError) {
        console.log(`  [control] error: ${r601.rgbaControlError}`)
      }
    } else {
      console.log('  (no bt601 result received)')
    }
    if (r709) {
      console.log('--- BT.709-tagged import (deliberately WRONG control) ---')
      console.log(`  drawImage_2d: measured=[${r709.drawImage}]`)
      console.log(`  copyExternalImageToTexture: measured=[${r709.copyExternal}]`)
      console.log(`  importExternalTexture: measured=[${r709.importExternal}]`)
      console.log(`  createImageBitmap: measured=[${r709.createImageBitmap}]`)
    }
    console.log('[poc] COLOR PROBE COMPLETE')
    setTimeout(() => app.quit(), 1500)
  })

  // Result 6 — native NV12→BGRA convert. The renderer reports, per variant
  // ('ref' = raw NV12 / 'bgra' = native-converted BGRA), the measured
  // center-patch RGB for each ingestion path it ran.
  const bgraResults = {}
  ipcMain.on('poc-bgra-result', (_e, r) => {
    console.log(`[poc] ===== BGRA RESULT (variant=${r.tag}) =====`)
    console.log(JSON.stringify(r, null, 2))
    bgraResults[r.tag] = r
    ipcMain.emit(`poc-bgra-variant-done-${r.tag}`)
  })
  ipcMain.on('poc-bgra-summary-request', () => {
    console.log('[poc] ===== RESULT 6 — NATIVE NV12→BGRA CONVERT: VERDICT =====')
    const ref = bgraResults.ref
    const bgra = bgraResults.bgra
    // The self-calibrating target: bgraViaWebGPU vs refDraw, +/-8/channel.
    const tol = 8
    const refDraw = ref && ref.drawImage // 2D drawImage of raw NV12, 601-tagged
    const bgraViaWebGPU = bgra && bgra.copyExternal // copyExternalImageToTexture of converted BGRA
    const bgraDraw = bgra && bgra.drawImage // 2D drawImage of converted BGRA (sanity)
    const brokenNv12WebGPU = [58, 217, 38] // the Result-5 wrong value, for contrast
    const diff = (a, b) => (a && b ? [a[0] - b[0], a[1] - b[1], a[2] - b[2]] : null)
    const maxAbs = (e) => (e ? Math.max(Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2])) : null)

    const srcMatrix = (process.env.POC_BGRA_MATRIX || '601').toLowerCase()
    console.log(`Source RGB fed to encoder: (20,220,40); source matrix = ${srcMatrix}`)
    console.log(`refDraw       (2D drawImage of RAW NV12, ${srcMatrix}-tagged) = [${refDraw}]`)
    console.log(`bgraViaWebGPU (copyExternalImageToTexture of native-BGRA) = [${bgraViaWebGPU}]`)
    console.log(`bgraDraw      (2D drawImage of native-BGRA, sanity)   = [${bgraDraw}]`)
    console.log(`(Result-5 broken raw-NV12-via-WebGPU value, for contrast) = [${brokenNv12WebGPU}]`)

    const errVsRef = diff(bgraViaWebGPU, refDraw)
    const maxErrVsRef = maxAbs(errVsRef)
    const errVsBroken = diff(bgraViaWebGPU, brokenNv12WebGPU)
    const maxErrVsBroken = maxAbs(errVsBroken)
    const matchesRef = maxErrVsRef != null && maxErrVsRef <= tol
    const notBroken = maxErrVsBroken != null && maxErrVsBroken > tol

    console.log(`bgraViaWebGPU err vs refDraw   = [${errVsRef}] maxAbs=${maxErrVsRef} (PASS if <= ${tol})`)
    console.log(`bgraViaWebGPU err vs broken    = [${errVsBroken}] maxAbs=${maxErrVsBroken} (want clearly > ${tol})`)

    // Sanity cross-check: the converted-BGRA drawImage should also match refDraw
    // (the native shader and drawImage should agree on the matrix-only convert).
    if (bgraDraw && refDraw) {
      const eb = diff(bgraDraw, refDraw)
      console.log(`bgraDraw err vs refDraw        = [${eb}] maxAbs=${maxAbs(eb)} (sanity: native shader vs drawImage)`)
    }

    const pass = matchesRef && notBroken
    console.log(
      `[poc] RESULT 6 VERDICT: ${pass ? 'PASS ✅ (native NV12→BGRA is color-correct, consistent with the pipeline, and stable through WebGPU)' : 'FAIL ❌ (see numbers above)'}`
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
    streaming || persistent || colorMode || bgraMode || cibPersistMode ? 60000 : 12000
  )
})

app.on('window-all-closed', () => app.quit())
