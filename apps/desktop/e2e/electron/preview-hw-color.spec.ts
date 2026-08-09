import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir, DECODE_ADDON, DECODE_COMPONENT_PRESENT } from './helpers/driver'

// Saturated-chart color gate for the Windows SHARED-TEXTURE hardware lane
// (d3d11va → GpuTransport) — the A′ color-sovereign path: native decodes on
// the GPU, converts NV12→RGBA with its OWN shader (constants derived from the
// same kr/kb source as Nv12Ingest / yuv10.ts), and shares sRGB-passthrough
// RGBA that the preload's createImageBitmap copies byte-for-byte (proven by
// the poc rgba probe). This spec is the lane's RESIDENT pixel-fidelity gate —
// the sibling SSIM gate (preview-hw-conformance) is structurally blind to
// matrix/range; this spec owns that.
//
// Four legs — the full matrix the native shader must honor per-session:
//   709ltd / 601ltd / 709full / 601full  (H.264 charts, npm run fixtures)
// A matrix swap reads 10–30 8-bit steps on the saturated patches; a range
// mix-up reads as a global contrast shift; both are far beyond PATCH_TOL.
//
// Model: preview-sw-color.spec.ts (chart method) + preview-hw-conformance
// (lane forcing + clean-skip). Needs a VITE_WEFTCUT_E2E=1 build + the built
// native-decode addon; d3d11va exists only on Windows.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const MANIFEST = path.resolve(MEDIA_DIR, 'color_manifest.json')

const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const SEEK_US = 500_000

// Windows-bound BY THE LANE, not by the addon: d3d11va is the only zero-copy
// GPU lane, and it is Windows-only. The component probe stays platform-generic
// (DECODE_ADDON) so a future lane here needs no filename surgery.
const COMPONENT_PRESENT = process.platform === 'win32' && DECODE_COMPONENT_PRESENT

// Patch-center ceiling in 8-bit code units. The chain pays the H.264 chart's
// own quantization, its 4:2:0 chroma siting, and the shader's RGBA8 rounding
// (≈1–2 steps each on flat patch centers) — same error classes (and the same
// ceiling) as the preview-sw-color ProRes gate. The defect class this guards
// (wrong matrix/range constants in the NATIVE shader) reads as tens of steps.
const PATCH_TOL = 8

interface ManifestPatch {
  id: string
  x: number
  y: number
  w: number
  h: number
  rgb: [number, number, number]
}

interface PatchOffender {
  id: string
  expected: [number, number, number]
  got: [number, number, number]
  maxErr: number
}

async function runChartLeg(label: string, fixture: string): Promise<void> {
  test.skip(!existsSync(fixture), `${label} chart fixture not found at ${fixture} (npm run fixtures)`)
  test.skip(!existsSync(MANIFEST), `color manifest not found at ${MANIFEST} (npm run fixtures)`)
  test.setTimeout(240_000)
  const PROJECT_PARENT = tmpDir('weftcut-e2e-preview-hw-color-proj-')
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    width: number
    height: number
    patches: ManifestPatch[]
  }
  expect(manifest.width).toBe(CANVAS.width) // 1:1 chart→composition mapping

  // Pin the resolver to the shared-texture lane only (+ software fallback).
  // Where d3d11va can't engage, the probe below reports hwLane === null and
  // the leg SKIPS cleanly instead of failing (preview-hw-conformance model).
  const { app, page } = await launchApp({ env: { WEFTCUT_FORCE_HW_LANE: 'd3d11va' } })
  const consoleLines: string[] = []
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e)}`))
  let toggledOn = false
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: `${label}-${Date.now()}`,
      canvas: CANVAS,
    })

    // Pin the ffmpeg engine BEFORE placing the layer (engine resolution reads
    // decode_engine live at acquire — see preview-sw-conformance.spec.ts).
    const after = (await invokeCmd(page, 'app_settings_set', {
      patch: { decode_engine: 'ffmpeg' },
    })) as { decode_engine: string }
    expect(after.decode_engine).toBe('ffmpeg')
    toggledOn = true

    const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: fixture })
    expect(kind).toBe('Video')

    await page.waitForFunction(
      () => {
        try {
          ;(window as unknown as { __weftcutTest: { activeClipProbe(id?: string): unknown } }).__weftcutTest.activeClipProbe()
          return true
        } catch {
          return false
        }
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )

    // Seek once, then poll read-only until a lane has decoded + bound the
    // target frame. Accept HW or the software fallback here; the clean-skip
    // below sorts out WHICH engaged.
    await page.evaluate(
      (us) => (window as unknown as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us),
      SEEK_US,
    )
    const handle = await page.waitForFunction(
      ([id, target]) => {
        const p = (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): {
          sourceKind: string; hwLane: string | null; ringLastPtsUs: number | null; spriteBound: boolean
        } | null } }).__weftcutTest.activeClipProbe(id)
        if (!p) return null
        if (p.sourceKind !== 'native-gpu' && p.sourceKind !== 'sw') return null
        if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
        if (!p.spriteBound) return null
        return p
      },
      [layerId, SEEK_US] as const,
      { timeout: 90_000, polling: 200 },
    )
    const probe = (await handle.jsonValue()) as { sourceKind: string; hwLane: string | null }

    test.skip(
      probe.hwLane !== 'd3d11va',
      `d3d11va not engaged on this machine (hwLane=${probe.hwLane}, sourceKind=${probe.sourceKind}) — lane unavailable`,
    )
    expect(probe.sourceKind).toBe('native-gpu')

    // Sample every patch center off the LIVE composited canvas (absolute
    // composition pixels — the chart is placed 1:1 at the origin).
    const offenders: PatchOffender[] = []
    let worst = 0
    for (const patch of manifest.patches) {
      const cx = patch.x + Math.floor(patch.w / 2)
      const cy = patch.y + Math.floor(patch.h / 2)
      const s = (await page.evaluate(
        ([x, y]) => (window as unknown as { __weftcutTest: { weftcutSampleComposite(x: number, y: number): Promise<{ r: number; g: number; b: number }> } }).__weftcutTest.weftcutSampleComposite(x, y),
        [cx, cy] as const,
      )) as { r: number; g: number; b: number }
      const got: [number, number, number] = [s.r, s.g, s.b]
      const maxErr = Math.max(
        Math.abs(got[0] - patch.rgb[0]),
        Math.abs(got[1] - patch.rgb[1]),
        Math.abs(got[2] - patch.rgb[2]),
      )
      worst = Math.max(worst, maxErr)
      if (maxErr > PATCH_TOL) offenders.push({ id: patch.id, expected: patch.rgb, got, maxErr })
    }
    // eslint-disable-next-line no-console
    console.log(`[preview-hw-color] ${label}: worst patch-center error ${worst} (tol ${PATCH_TOL})`)
    const errs = consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[warning]') || l.startsWith('[pageerror]'))
    // eslint-disable-next-line no-console
    if (errs.length) console.log(`[preview-hw-color] ${label} renderer errors during run:\n` + errs.join('\n'))
    expect(offenders, JSON.stringify(offenders)).toHaveLength(0)
  } finally {
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
    }
    await app.close()
  }
}

test.describe('preview shared-texture HW saturated-chart color gate (Electron)', () => {
  test.skip(!COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native GPU sessions`)

  for (const enc of ['709ltd', '601ltd', '709full', '601full'] as const) {
    test(`${enc} chart previews correctly through the d3d11va shared-texture lane @serial`, async () => {
      await runChartLeg(`phc-${enc}`, path.resolve(MEDIA_DIR, `test_1080p_color_${enc}.mp4`))
    })
  }
})
