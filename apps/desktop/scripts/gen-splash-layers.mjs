// Rasterize the splash-screen launch mark into 4 transparent PNG layers (2x),
// so the splash can be re-implemented as stacked raster layers.
//
//   node apps/desktop/scripts/gen-splash-layers.mjs
//
// Outputs (all 1280x880 = 2x of the 640x440 viewBox, RGBA, transparent bg):
//   src/renderer/public/splash/film-final@2x.png   film frame with the FINAL
//                                                  cutout applied (original
//                                                  final frame of masked film)
//   src/renderer/public/splash/w-cut-filler@2x.png film-colored material the
//                                                  W-cut removes:
//                                                  film ∧ (w-cutout-shape,
//                                                  stroke 24, translate(100 0))
//                                                  ∧ reveal rect
//   src/renderer/public/splash/wedge-filler@2x.png film ∧ wedge paths
//                                                  ∧ rect(100,147,440,142)
//                                                  ∖ w-cutout-shape (true
//                                                  boundary: fill + stroke 24)
//   src/renderer/public/splash/w-paint@2x.png      the blue W (#6696E6) as-is
//
// The wedge shapes and the W-cutout band overlap. The original single mask
// cuts the overlap during the W-cut sweep, so the overlap is assigned solely
// to the w-cut filler; the wedge filler subtracts the cutout at its true
// boundary. Otherwise the wedge filler would keep painting film color over
// the swept region until the middle-open phase ("ghost" pixels).
//
// Geometry is copied verbatim from the frozen snapshot
// .scratch/splash-compare/HEAD-SplashScreen.tsx (the live component is being
// rewritten concurrently — do not read it). HEAD-icon.svg in the same dir is
// the canonical icon with identical geometry shifted by -100 in x; it is used
// as an independent cross-check of the path transcription.
//
// Rasterization follows gen-icons.mjs: Electron's Chromium renders each SVG
// into a hidden window's <canvas> (true alpha) and returns PNG bytes. This
// script is dual-mode: run with plain `node`, it spawns the repo's Electron
// binary (which re-runs this file with SPLASH_GEN_CHILD=1) to do the
// rendering; the parent then verifies the layers with pngjs and writes
// verification composites to .scratch/splash-layers/.
//
// Verification (mandatory, runs on every invocation):
//   1. film-final + w-paint composited == final-reference (original final
//      frame: masked film + blue W), rendered with the same rasterizer.
//   2. film-final + w-cut-filler + wedge-filler composited == intact film.
//   3. film-final + wedge-filler composited (w-cut-filler omitted) ==
//      mid-animation original (reveal fully open, middle clip scaleY(0)).
//   4. final-reference == HEAD-icon.svg render shifted by +200px (cross-check
//      of all path data against the canonical icon).
// Expected: all at 0 differing pixels (modulo ±1 rounding, the documented
// icon-rounding residue, and a few pixels where wedge and cutout AA edges
// cross in check 3).
//
// Note on check 2: splitting the film into kept/removed pieces along an
// anti-aliased cut edge cannot recombine exactly under source-over — kept
// alpha (1-c) plus removed alpha c composites to 1-c(1-c), not 1. The browser
// makes this worse: each layer is downscaled from 1280px independently, so
// abutting alpha ramps resample differently and show as faint seams tracing
// the cut geometry. To kill the seams, the filler masks are dilated 4 viewBox
// units beyond the true cut geometry (w-cutout stroke 24→32, wedges get
// stroke 8), so each filler fully covers its cut edge's AA ramp with full
// film alpha and the overlap (same color on same color) survives resampling.
// The wedge filler's channel-side edge is NOT dilated — the cutout
// subtraction keeps it at the true boundary, so no film-colored ghost
// remains after the w-cut filler is erased (see layer 3 below).

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(here, '..', 'src', 'renderer', 'public', 'splash')
const SCRATCH_DIR = join(here, '..', '..', '..', '.scratch', 'splash-layers')
const ICON_SNAPSHOT = join(here, '..', '..', '..', '.scratch', 'splash-compare', 'HEAD-icon.svg')
const ICON_LIVE = join(here, '..', 'src', 'renderer', 'public', 'icons', 'icon.svg')

// Device pixels and viewBox units.
const W = 1280
const H = 880
const VW = 640
const VH = 440

const FILM_COLOR = '#5B7196'
const W_COLOR = '#6696E6'

// --- Path data, verbatim from .scratch/splash-compare/HEAD-SplashScreen.tsx ---

const FILM_PATH =
  'M505 0C524.33 0 540 15.67 540 35V405C540 424.33 524.33 440 505 440H135C115.67 440 100 424.33 100 405V35C100 15.67 115.67 0 135 0H505ZM158 336C151.373 336 146 341.373 146 348V390C146 396.627 151.373 402 158 402H200C206.627 402 212 396.627 212 390V348C212 341.373 206.627 336 200 336H158ZM299 336C292.373 336 287 341.373 287 348V390C287 396.627 292.373 402 299 402H341C347.627 402 353 396.627 353 390V348C353 341.373 347.627 336 341 336H299ZM440 336C433.373 336 428 341.373 428 348V390C428 396.627 433.373 402 440 402H482C488.627 402 494 396.627 494 390V348C494 341.373 488.627 336 482 336H440ZM158 38C151.373 38 146 43.373 146 50V92C146 98.627 151.373 104 158 104H200C206.627 104 212 98.627 212 92V50C212 43.373 206.627 38 200 38H158ZM299 38C292.373 38 287 43.373 287 50V92C287 98.627 292.373 104 299 104H341C347.627 104 353 98.627 353 92V50C353 43.373 347.627 38 341 38H299ZM440 38C433.373 38 428 43.373 428 50V92C428 98.627 433.373 104 440 104H482C488.627 104 494 98.627 494 92V50C494 43.373 488.627 38 482 38H440Z'

const W_SHAPE =
  'M300.117 167.417L251.477 239.378C249.409 242.438 244.851 242.276 243.004 239.078L195.331 156.5C192.652 151.859 187.7 149 182.34 149H110C104.478 149 100 153.477 100 159V183C100 188.523 104.478 193 110 193H157.306C162.684 193 167.65 195.879 170.322 200.545L224.679 295.455C227.352 300.121 232.318 303 237.696 303H254.024C259.011 303 263.672 300.522 266.461 296.387L320.001 217L373.541 296.387C376.329 300.522 380.99 303 385.977 303H402.306C407.683 303 412.649 300.121 415.322 295.455L469.679 200.545C472.352 195.879 477.318 193 482.696 193H530C535.523 193 540 188.523 540 183V159C540 153.477 535.523 149 530 149H457.661C452.302 149 447.35 151.859 444.671 156.5L396.997 239.078C395.151 242.276 390.593 242.438 388.525 239.378L339.885 167.417C330.368 153.337 309.634 153.337 300.117 167.417Z'

const W_CUTOUT =
  'M85.2271 137C93.0869 137 100.35 141.193 104.28 148L147.801 223.386L193.489 155.794C206.178 137.021 233.823 137.021 246.512 155.794L292.199 223.386L335.721 148C339.651 141.193 346.914 137 354.774 137H452V205H380.957L324.294 303.934C320.375 310.778 313.091 315 305.204 315H283.318C276.004 315 269.168 311.365 265.079 305.301L220 238.462L174.922 305.301C170.833 311.365 163.997 315 156.683 315H134.797C126.91 315 119.626 310.778 115.707 303.934L59.0444 205H-11.9995V137H85.2271Z'

const WEDGE_LEFT = 'M100 125H149.0005L249.353 327H100V125Z'
const WEDGE_RIGHT = 'M540 125H490L386.652 327H540V125Z'

// Final-state clip rects (fully open).
const REVEAL_RECT = '<rect x="88" y="120" width="464" height="207"/>'
const MIDDLE_RECT = '<rect x="100" y="147" width="440" height="142"/>'

// Filler-mask-only variants, extended 4 units at the bottom. The true rects'
// bottom edges coincide with true cut boundaries (reveal y=327, middle
// y=289), so sharing them would clip the dilation to zero on exactly the
// edges that face intact film and need the overlap most. Extending them only
// widens the filler into film-colored (never-cut) territory — harmless.
const FILLER_REVEAL_RECT = '<rect x="88" y="120" width="464" height="211"/>'
const FILLER_MIDDLE_RECT = '<rect x="100" y="147" width="440" height="146"/>'

// --- SVG document builders ---------------------------------------------------

const svgDoc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${VW} ${VH}" fill="none">${body}</svg>`

const SHARED_DEFS =
  `<defs>` +
  `<clipPath id="reveal">${REVEAL_RECT}</clipPath>` +
  `<clipPath id="middle">${MIDDLE_RECT}</clipPath>` +
  `</defs>`

// The original mask at final state: white over the film, black where the
// middle-open wedges and the reveal-clipped W cutout remove material.
const CUT_MASK =
  `<mask id="cut" maskUnits="userSpaceOnUse" x="76" y="0" width="489" height="440">` +
  `<rect x="100" width="440" height="440" fill="white"/>` +
  `<g clip-path="url(#middle)">` +
  `<path d="${WEDGE_LEFT}" fill="black"/>` +
  `<path d="${WEDGE_RIGHT}" fill="black"/>` +
  `</g>` +
  `<g clip-path="url(#reveal)">` +
  `<path d="${W_CUTOUT}" transform="translate(100 0)" fill="black" stroke="black" stroke-width="24"/>` +
  `</g>` +
  `</mask>`

const FILM_GROUP = `<g mask="url(#cut)"><path d="${FILM_PATH}" fill="${FILM_COLOR}"/></g>`

// Layer 1: film minus [(cutout ∧ reveal) ∪ (wedges ∧ middle)] — the original
// final frame of the masked film, exactly.
const svgFilmFinal = svgDoc(SHARED_DEFS.replace('</defs>', CUT_MASK + '</defs>') + FILM_GROUP)

// Layer 2: film ∧ (cutout ∧ reveal). A luminance mask is used (white where
// material is kept) because clipPath children ignore stroke per the SVG spec,
// and the cutout's 24px stroke is part of its geometry — the mask rasterizes
// the stroked shape exactly like the original mask does. The stroke is
// widened 24→32 to dilate the filler 4 units past the cut edge's AA ramp
// (see header), which does not change how the layer reads on its own.
const svgWCutFiller = svgDoc(
  `<defs><clipPath id="reveal">${FILLER_REVEAL_RECT}</clipPath>` +
    `<mask id="keep" maskUnits="userSpaceOnUse" x="0" y="0" width="${VW}" height="${VH}">` +
      `<g clip-path="url(#reveal)">` +
      `<path d="${W_CUTOUT}" transform="translate(100 0)" fill="white" stroke="white" stroke-width="32"/>` +
      `</g>` +
      `</mask></defs>` +
    `<g mask="url(#keep)"><path d="${FILM_PATH}" fill="${FILM_COLOR}"/></g>`,
)

// Layer 3: film ∧ wedges ∧ middle rect, MINUS the W cutout. The wedge shapes
// and the W-cutout band overlap; in the original single mask the overlap is
// cut during the W-cut sweep, so it belongs solely to the w-cut filler.
// Leaving it in both fillers made the wedge filler keep painting film color
// over the swept region until the middle-open phase (the "ghost" pixels).
// Hence the black subtraction of the cutout (fill + stroke, translate(100 0)).
// The subtraction boundary depends on which side of the middle rect the
// material faces:
// - Inside the rect the cutout's true stroke-24 boundary is used. There
//   film-final is fully removed by the wedge cut, so the filler's (1-c) ramp
//   recomposites exactly with the original's single ramp. Using the dilated
//   boundary here would leave the cutout..cutout+4 band — which IS inside
//   the true wedge cut — uncovered (transparent) after the w-cut sweep,
//   re-introducing a background-colored ghost along the channel.
// - Below the rect (the +4 seam-overlap strip), film-final is NOT removed by
//   the wedge cut and carries the cutout's AA ramp itself, so the strip is
//   trimmed by the dilated stroke-32 boundary to keep it off that ramp
//   (otherwise both layers share the ramp and double-composite it — the
//   ~1px speckle where the bite crosses y=289).
// The wedges keep their 8-unit white stroke: it dilates only their OUTER
// boundary against intact film (see header), and where it reaches into the
// cutout band the black subtraction wins anyway (black paints last).
const svgWedgeFiller = svgDoc(
  `<defs><clipPath id="middle">${FILLER_MIDDLE_RECT}</clipPath>` +
    `<clipPath id="below-mid"><rect x="88" y="289" width="464" height="60"/></clipPath>` +
    `<mask id="keep" maskUnits="userSpaceOnUse" x="0" y="0" width="${VW}" height="${VH}">` +
      `<g clip-path="url(#middle)">` +
      `<path d="${WEDGE_LEFT}" fill="white" stroke="white" stroke-width="8"/>` +
      `<path d="${WEDGE_RIGHT}" fill="white" stroke="white" stroke-width="8"/>` +
      `</g>` +
      `<path d="${W_CUTOUT}" transform="translate(100 0)" fill="black" stroke="black" stroke-width="24"/>` +
      `<g clip-path="url(#below-mid)">` +
      `<path d="${W_CUTOUT}" transform="translate(100 0)" fill="black" stroke="black" stroke-width="32"/>` +
      `</g>` +
      `</mask></defs>` +
    `<g mask="url(#keep)"><path d="${FILM_PATH}" fill="${FILM_COLOR}"/></g>`,
)

// Layer 4: the blue W, as-is.
const svgWPaint = svgDoc(`<path d="${W_SHAPE}" fill="${W_COLOR}"/>`)

// Reference: the original final frame — masked film, then the reveal-clipped
// blue W on top (the clip is a no-op at final state but kept for fidelity).
const svgFinalReference = svgDoc(
  SHARED_DEFS.replace('</defs>', CUT_MASK + '</defs>') +
    FILM_GROUP +
    `<g clip-path="url(#reveal)"><path d="${W_SHAPE}" fill="${W_COLOR}"/></g>`,
)

// Reference: fully intact film, no cut.
const svgIntactFilm = svgDoc(`<path d="${FILM_PATH}" fill="${FILM_COLOR}"/>`)

// Reference: the original mask mid-animation — W-cut sweep finished (reveal
// fully open) but the middle not yet opened. In the original the middle clip
// rect animates scaleY 0→1; at scaleY(0) it has zero area and clips its whole
// group away, which a height-0 rect reproduces exactly (a zero-size rect
// disables rendering per the SVG spec, leaving an empty clip). So the mask
// subtracts only (cutout ∧ reveal) from the film, no W paint on top.
const DEFS_MIDCUT =
  `<defs>` +
  `<clipPath id="reveal">${REVEAL_RECT}</clipPath>` +
  `<clipPath id="middle"><rect x="100" y="147" width="440" height="0"/></clipPath>` +
  `</defs>`
const svgMidcutReference = svgDoc(DEFS_MIDCUT.replace('</defs>', CUT_MASK + '</defs>') + FILM_GROUP)

// --- Electron child: render SVGs to PNGs ------------------------------------

async function runChild() {
  const { app, BrowserWindow } = await import('electron')

  const iconPath = existsSync(ICON_SNAPSHOT) ? ICON_SNAPSHOT : ICON_LIVE
  const iconSvg = readFileSync(iconPath, 'utf8')
    .replace(/width="\d+"/, 'width="880"')
    .replace(/height="\d+"/, 'height="880"')

  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(SCRATCH_DIR, { recursive: true })
  mkdirSync(join(SCRATCH_DIR, 'svg'), { recursive: true })

  // [filename, svg, canvasWidth, canvasHeight, outputDir]
  const renders = [
    ['film-final@2x.png', svgFilmFinal, W, H, OUT_DIR],
    ['w-cut-filler@2x.png', svgWCutFiller, W, H, OUT_DIR],
    ['wedge-filler@2x.png', svgWedgeFiller, W, H, OUT_DIR],
    ['w-paint@2x.png', svgWPaint, W, H, OUT_DIR],
    ['final-reference.png', svgFinalReference, W, H, SCRATCH_DIR],
    ['intact-film.png', svgIntactFilm, W, H, SCRATCH_DIR],
    ['midcut-reference.png', svgMidcutReference, W, H, SCRATCH_DIR],
    ['icon-reference.png', iconSvg, 880, 880, SCRATCH_DIR],
  ]

  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: W, height: H })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<meta charset="utf-8">'))

    for (const [name, svg, cw, ch, dir] of renders) {
      writeFileSync(join(SCRATCH_DIR, 'svg', name.replace(/@2x\.png$|\.png$/g, '.svg')), svg)
      // Canvas 2D + toDataURL preserve true alpha (see gen-icons.mjs).
      const dataUrl = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
        await img.decode();
        const c = document.createElement('canvas');
        c.width = ${cw}; c.height = ${ch};
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, ${cw}, ${ch});
        ctx.drawImage(img, 0, 0, ${cw}, ${ch});
        return c.toDataURL('image/png');
      })()`)
      const bytes = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')
      writeFileSync(join(dir, name), bytes)
      console.log(`rendered ${name} (${cw}x${ch}, ${bytes.length} bytes)`)
    }
    app.quit()
  }).catch((err) => {
    console.error('gen-splash-layers render failed:', err)
    app.exit(1)
  })
}

// --- Node parent: spawn Electron, then verify --------------------------------

function runParent() {
  const require = createRequire(import.meta.url)
  const electronBinary = require('electron')
  const scriptPath = fileURLToPath(import.meta.url)

  const child = spawn(electronBinary, [scriptPath], {
    env: { ...process.env, SPLASH_GEN_CHILD: '1' },
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`gen-splash-layers: electron renderer exited with code ${code}`)
      process.exit(code ?? 1)
    }
    verify(require)
  })
}

function verify(require) {
  const { PNG } = require('pngjs')

  const load = (dir, name) => PNG.sync.read(readFileSync(join(dir, name)))
  const filmFinal = load(OUT_DIR, 'film-final@2x.png')
  const wCutFiller = load(OUT_DIR, 'w-cut-filler@2x.png')
  const wedgeFiller = load(OUT_DIR, 'wedge-filler@2x.png')
  const wPaint = load(OUT_DIR, 'w-paint@2x.png')
  const finalRef = load(SCRATCH_DIR, 'final-reference.png')
  const intactRef = load(SCRATCH_DIR, 'intact-film.png')
  const midcutRef = load(SCRATCH_DIR, 'midcut-reference.png')
  const iconRef = load(SCRATCH_DIR, 'icon-reference.png')

  let failures = 0
  const fail = (msg) => {
    failures++
    console.error(`FAIL: ${msg}`)
  }

  // Shape checks: exact size, RGBA, real transparency, real opacity.
  const px = (png, x, y) => {
    const i = (y * png.width + x) * 4
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]
  }
  const checkShape = (png, name, w, h, opaqueSamples) => {
    if (png.width !== w || png.height !== h) fail(`${name}: ${png.width}x${png.height}, expected ${w}x${h}`)
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      if (px(png, x, y)[3] !== 0) fail(`${name}: corner (${x},${y}) alpha ${px(png, x, y)[3]}, expected 0`)
    }
    for (const [x, y] of opaqueSamples) {
      if (px(png, x, y)[3] !== 255) fail(`${name}: content (${x},${y}) alpha ${px(png, x, y)[3]}, expected 255`)
    }
    console.log(`ok: ${name} is ${png.width}x${png.height} RGBA with transparent corners and opaque content`)
  }
  // Sample points below are given in device px (2x of viewBox coords).
  checkShape(filmFinal, 'film-final@2x.png', W, H, [[640, 40]])        // top bar (320,20)
  checkShape(wCutFiller, 'w-cut-filler@2x.png', W, H, [[300, 340]])    // cut band (150,170)
  checkShape(wedgeFiller, 'wedge-filler@2x.png', W, H, [[210, 500]])   // left wedge (105,250)
  checkShape(wPaint, 'w-paint@2x.png', W, H, [[240, 340]])             // W left arm (120,170)
  checkShape(finalRef, 'final-reference.png', W, H, [[640, 40]])
  checkShape(intactRef, 'intact-film.png', W, H, [[640, 40], [300, 340], [210, 500]])
  checkShape(midcutRef, 'midcut-reference.png', W, H, [[640, 40], [210, 500]])

  // The wedge/cutout overlap belongs solely to the w-cut filler: points inside
  // both the left wedge and the cutout band must be FULLY transparent in the
  // wedge filler (regression check for the mid-sweep "ghost" pixels).
  for (const [x, y, vb] of [
    [214, 296, '(107,148)'],
    [300, 340, '(150,170)'],
  ]) {
    if (px(wedgeFiller, x, y)[3] !== 0) {
      fail(`wedge-filler@2x.png: wedge∧cutout point ${vb} alpha ${px(wedgeFiller, x, y)[3]}, expected 0 (overlap must belong to w-cut-filler only)`)
    }
  }
  console.log('ok: wedge-filler@2x.png is fully transparent inside the wedge∧cutout overlap')

  // Unpremultiplied source-over compositing.
  const over = (bottom, top) => {
    const out = new PNG({ width: bottom.width, height: bottom.height })
    for (let i = 0; i < bottom.data.length; i += 4) {
      const ab = bottom.data[i + 3] / 255
      const at = top.data[i + 3] / 255
      const ao = at + ab * (1 - at)
      out.data[i + 3] = Math.round(ao * 255)
      for (let c = 0; c < 3; c++) {
        out.data[i + c] =
          ao === 0 ? 0 : Math.round((top.data[i + c] * at + bottom.data[i + c] * ab * (1 - at)) / ao)
      }
    }
    return out
  }

  const diff = (a, b, xOffA = 0, yOffA = 0) => {
    // Compares b against a shifted by (xOffA, yOffA) over their overlap.
    const x0 = Math.max(0, xOffA)
    const y0 = Math.max(0, yOffA)
    const x1 = Math.min(a.width + xOffA, b.width)
    const y1 = Math.min(a.height + yOffA, b.height)
    let count = 0
    let countTight = 0 // |delta| > 1
    let maxDelta = 0
    let bbox = null
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const pa = px(a, x - xOffA, y - yOffA)
        const pb = px(b, x, y)
        let d = 0
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa[c] - pb[c]))
        if (d > 0) {
          count++
          if (d > 1) countTight++
          maxDelta = Math.max(maxDelta, d)
          bbox = bbox
            ? [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)]
            : [x, y, x, y]
        }
      }
    }
    return { count, countTight, maxDelta, bbox }
  }

  const writePng = (name, png) => {
    writeFileSync(join(SCRATCH_DIR, name), PNG.sync.write(png))
    console.log(`wrote ${join(SCRATCH_DIR, name)}`)
  }

  // Dark-background preview for eyeballing (splash bg ~ #0e131c).
  const onDark = (png) => {
    const bg = new PNG({ width: png.width, height: png.height })
    for (let i = 0; i < bg.data.length; i += 4) {
      bg.data[i] = 0x0e
      bg.data[i + 1] = 0x13
      bg.data[i + 2] = 0x1c
      bg.data[i + 3] = 255
    }
    return over(bg, png)
  }

  // Check 1: film-final + w-paint == original final frame.
  const compFinal = over(filmFinal, wPaint)
  writePng('composite-final.png', compFinal)
  writePng('preview-final-dark.png', onDark(compFinal))
  const d1 = diff(compFinal, finalRef)
  console.log(
    `check 1 (film-final + w-paint vs final-reference): ${d1.count} differing px ` +
      `(${d1.countTight} with |Δ|>1, max |Δ|=${d1.maxDelta})` +
      (d1.bbox ? ` bbox=${d1.bbox}` : ''),
  )
  if (d1.countTight > 50 || d1.maxDelta > 8) fail('check 1: composite deviates from the original final frame')

  // Check 2: film-final + w-cut-filler + wedge-filler == intact film.
  const compIntact = over(over(filmFinal, wCutFiller), wedgeFiller)
  writePng('composite-intact.png', compIntact)
  writePng('preview-intact-dark.png', onDark(compIntact))
  const d2 = diff(compIntact, intactRef)
  console.log(
    `check 2 (film-final + w-cut-filler + wedge-filler vs intact film): ${d2.count} differing px ` +
      `(${d2.countTight} with |Δ|>1, max |Δ|=${d2.maxDelta})` +
      (d2.bbox ? ` bbox=${d2.bbox}` : ''),
  )
  if (d2.countTight > 50 || d2.maxDelta > 8) fail('check 2: layers do not sum back to the intact film')

  // Check 3: mid-animation state — W-cut sweep done, middle not yet open.
  // Composite [film-final, wedge-filler] (w-cut-filler omitted, simulating
  // post-sweep) must equal the original mask with the middle clip collapsed.
  // Expect near-0: exact except at pixels where the wedge AA edge crosses the
  // cutout AA edge (both fractional, |Δ| ≤ ~32).
  const compMid = over(filmFinal, wedgeFiller)
  writePng('composite-midcut.png', compMid)
  writePng('preview-midcut-dark.png', onDark(compMid))
  const dMid = diff(compMid, midcutRef)
  console.log(
    `check 3 (film-final + wedge-filler vs mid-animation original): ${dMid.count} differing px ` +
      `(${dMid.countTight} with |Δ|>1, max |Δ|=${dMid.maxDelta})` +
      (dMid.bbox ? ` bbox=${dMid.bbox}` : ''),
  )
  if (dMid.countTight > 50 || dMid.maxDelta > 64) fail('check 3: post-sweep composite deviates from the original mid-animation state')

  // Check 4: final-reference == canonical icon.svg shifted +100 viewBox px
  // (= +200 device px) in x. Validates all transcribed path data.
  const d3 = diff(iconRef, finalRef, 200, 0)
  console.log(
    `check 4 (final-reference vs HEAD-icon.svg @ +200px): ${d3.count} differing px ` +
      `(${d3.countTight} with |Δ|>1, max |Δ|=${d3.maxDelta})` +
      (d3.bbox ? ` bbox=${d3.bbox}` : ''),
  )
  // Upstream reality: the frozen component and the frozen icon differ by
  // Figma-export rounding (icon uses x.001 / 0.000488281-style coordinates
  // where the component rounds to integers). That yields exactly 7 pixels of
  // AA difference — one at each of the 6 perforation-hole corners and one on
  // the W's left edge — all |Δ| ≤ 32. The component is the source of truth
  // (check 1 proves the layers match it exactly), so tolerate that known
  // residue but fail on anything larger (e.g. a transcription error).
  if (d3.countTight > 10 || d3.maxDelta > 64) fail('check 4: geometry deviates from the canonical icon')

  // Per-layer dark-background previews for eyeballing.
  for (const [name, png] of [
    ['film-final', filmFinal],
    ['w-cut-filler', wCutFiller],
    ['wedge-filler', wedgeFiller],
    ['w-paint', wPaint],
  ]) {
    writePng(`layer-${name}-dark.png`, onDark(png))
  }

  if (failures > 0) {
    console.error(`gen-splash-layers: ${failures} verification failure(s)`)
    process.exit(1)
  }
  console.log('gen-splash-layers: all verification checks passed')
}

if (process.env.SPLASH_GEN_CHILD === '1') {
  await runChild()
} else {
  runParent()
}
