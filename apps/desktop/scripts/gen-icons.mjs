// Rasterize the canonical brand SVG into the packaging master PNG.
//
// The single source of truth is the vector at
// `src/renderer/public/icons/icon.svg` (also the app favicon). electron-builder
// can't ingest an SVG, so it needs one raster master — from `build/icon.png`
// (1024x1024) it derives the Windows .ico, the macOS .icns, and the Linux png
// set. Re-run this after any palette tweak to the SVG:
//
//   npm run gen:icons --workspace apps/desktop
//
// No ImageMagick/rsvg/sharp on the toolchain, but Electron's Chromium is a
// dependency and its 2D canvas is a faithful SVG rasterizer with true alpha —
// so we render the SVG into a hidden window's <canvas> and read back the PNG
// bytes via toDataURL. `show:false` is enough: canvas 2D + toDataURL run in the
// renderer regardless of visibility (only capturePage() would need a paint).
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const svgPath = join(here, '..', 'src', 'renderer', 'public', 'icons', 'icon.svg')
const outPath = join(here, '..', 'build', 'icon.png')
const SIZE = 1024

const svg = readFileSync(svgPath, 'utf8')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<meta charset="utf-8">'))

  // Force the SVG's intrinsic size to the target so Chromium rasterizes the
  // vector AT full resolution (drawImage on an under-sized intrinsic would
  // upscale a small bitmap and blur). The viewBox keeps the geometry correct.
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(svg)}
      .replace(/width="\\d+"/, 'width="${SIZE}"')
      .replace(/height="\\d+"/, 'height="${SIZE}"');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = ${SIZE}; c.height = ${SIZE};
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, ${SIZE}, ${SIZE});
    ctx.drawImage(img, 0, 0, ${SIZE}, ${SIZE});
    return c.toDataURL('image/png');
  })()`)

  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  const bytes = Buffer.from(b64, 'base64')
  writeFileSync(outPath, bytes)
  console.log(`gen-icons: wrote ${outPath} (${SIZE}x${SIZE}, ${bytes.length} bytes)`)
  app.quit()
}).catch((err) => {
  console.error('gen-icons failed:', err)
  app.exit(1)
})
