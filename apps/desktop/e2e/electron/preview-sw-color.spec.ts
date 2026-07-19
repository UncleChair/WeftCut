import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir, waitForHook } from './helpers/driver'

// Saturated-chart color gate for the native software-decode PREVIEW lane
// (policy ADR 0032). The preview twin of export-prores-fidelity's Gate A: a
// color-tagged ProRes chart, decoded by the native SW session and composited
// live, must show the chart's colors at the preview seam — proving the
// ring's NativeNv12Frames convert through the owned `Nv12Ingest` matrix
// (which the WebGPU-preferring preview renderer runs via the shader's WGSL
// twin), not Chromium's buffer-frame conversion.
//
// WHY THIS GATE EXISTS — the sibling gates are structurally blind here: the
// preview-sw conformance/families gates assert ffmpeg-SSIM ≥ 0.98 on NATURAL
// content, but ffmpeg SSIM weights chroma ~1/6 and a 601↔709 matrix swap
// barely moves luma, so the BT.601 tint (Chromium software-converting
// buffer-defined NV12 VideoFrames as 601 regardless of the stamped
// colorSpace) passes them cleanly. Saturated flat patches turn the same
// defect into tens of 8-bit steps. Never treat a natural-content SSIM floor
// as evidence of matrix correctness (ADR 0032).
//
// Two legs:
//   A. bt709-tagged chart — renders WITHOUT the 601 tint (the ticket's bug).
//   B. smpte170m-tagged chart — still selects BT.601 (no over-correction:
//      a fix that hard-codes 709 would pass leg A and fail this one).
// Same run requirements as preview-sw-conformance.spec.ts: a
// VITE_WEFTCUT_E2E=1 build and the built native-decode component.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const CHART_709 = path.resolve(MEDIA_DIR, 'test_1080p_color_709ltd_prores.mov')
const CHART_601 = path.resolve(MEDIA_DIR, 'test_1080p_color_601ltd_prores.mov')
const MANIFEST = path.resolve(MEDIA_DIR, 'color_manifest.json')

const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const SEEK_US = 500_000 // mid-chart; the chart is static, any decoded frame shows it

// Component presence (same level-0 probe as export-prores-fidelity.spec.ts):
// without the built addon the app cannot open native SW sessions, so the
// native-sw route never commits and the gate would time out rather than
// mean anything. Windows-only today.
const DECODE_ADDON = path.resolve(__dirname, '../../native/decode/index.win32-x64-msvc.node')
const COMPONENT_PRESENT = process.platform === 'win32' && existsSync(DECODE_ADDON)

// Patch-center app-error ceiling in 8-bit code units, matching the export
// chart gate (COLOR_APP_MAX): the chain pays the ProRes master's 10-bit→8-bit
// requantization, the NV12 transport's 4:2:2→4:2:0 chroma resample, and the
// ingest's RGBA8 round-trip (≈1–2 steps each on flat patch centers). The
// failure this guards — a wrong matrix in the preview convert — reads as
// 10–30 steps on the saturated patches.
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
  const PROJECT_PARENT = tmpDir('weftcut-e2e-preview-sw-color-proj-')
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    width: number
    height: number
    patches: ManifestPatch[]
  }
  expect(manifest.width).toBe(CANVAS.width) // 1:1 chart→composition mapping

  const { app, page } = await launchApp()
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

    const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: fixture })
    expect(kind).toBe('Video')

    await waitForHook(page, 'mediaDecodeRouteKind')
    await page.waitForFunction(
      (id) => (window as unknown as { __weftcutTest: { mediaDecodeRouteKind(m: string): string | null } }).__weftcutTest.mediaDecodeRouteKind(id) === 'native-sw',
      mediaId,
      { timeout: 90_000, polling: 500 },
    )
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

    // Seek once, then poll read-only until the SW lane has decoded + bound the
    // target frame (re-seeking every poll would restart the scrub debounce).
    await page.evaluate(
      (us) => (window as unknown as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us),
      SEEK_US,
    )
    await page.waitForFunction(
      ([id, target]) => {
        const p = (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): {
          sourceKind: string; ringSize: number; ringLastPtsUs: number | null; spriteBound: boolean
        } | null } }).__weftcutTest.activeClipProbe(id)
        if (!p) return null
        if (p.sourceKind !== 'sw') return null // the gate is about the NATIVE SW lane
        if (p.ringSize < 1) return null
        if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
        if (!p.spriteBound) return null
        return true
      },
      [layerId, SEEK_US] as const,
      { timeout: 90_000, polling: 200 },
    )

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
    console.log(`[preview-sw-color] ${label}: worst patch-center error ${worst} (tol ${PATCH_TOL})`)
    // Dump renderer errors BEFORE the patch assertion — a WebGPU pipeline
    // failure surfaces here, and the assertion throwing first would hide it.
    const errs = consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[warning]') || l.startsWith('[pageerror]'))
    // eslint-disable-next-line no-console
    if (errs.length) console.log(`[preview-sw-color] ${label} renderer errors during run:\n` + errs.join('\n'))
    expect(offenders, JSON.stringify(offenders)).toHaveLength(0)
  } finally {
    // Restore the app-level engine pin (it persists cross-project).
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
    }
    await app.close()
  }
}

test.describe('preview native-SW saturated-chart color gate (Electron)', () => {
  test.skip(!COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native SW sessions`)

  test('bt709-tagged ProRes chart previews without the BT.601 tint', async () => {
    await runChartLeg('psc-709', CHART_709)
  })

  test('smpte170m-tagged ProRes chart still selects BT.601 (no over-correction)', async () => {
    await runChartLeg('psc-601', CHART_601)
  })
})
