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

sharedTexture.setSharedTextureReceiver(async (data) => {
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
})

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('renderer-ready')
})

ipcRenderer.on('poc-error', (_e, msg) => {
  const el = document.getElementById('log')
  if (el) el.textContent = '❌ main process error:\n' + msg
})
