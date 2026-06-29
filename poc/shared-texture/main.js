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

async function pushTexture(win) {
  const tex = native.pocCreateSyntheticTexture(FORMAT)
  console.log(`[poc] native ${tex.pixelFormat} texture id=${tex.id} adapter="${tex.adapter}" handle=${tex.handleValue} (${tex.handle.length} bytes)`)

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

  ipcMain.on('renderer-ready', async () => {
    try {
      await pushTexture(win)
    } catch (e) {
      const msg = String((e && e.stack) || e)
      console.error('[poc] pushTexture FAILED:', msg)
      win.webContents.send('poc-error', msg)
    }
  })

  ipcMain.on('poc-result', (_e, result) => {
    console.log('[poc] ===== RENDERER RESULT =====')
    console.log(JSON.stringify(result, null, 2))
    // Keep the window up briefly, then exit so the run is non-interactive.
    setTimeout(() => app.quit(), 2500)
  })

  // Watchdog: never hang headless. If nothing reported a result (import threw,
  // sendSharedTexture timed out, etc.), exit anyway.
  setTimeout(() => {
    console.log('[poc] watchdog timeout — quitting')
    app.quit()
  }, 12000)
})

app.on('window-all-closed', () => app.quit())
