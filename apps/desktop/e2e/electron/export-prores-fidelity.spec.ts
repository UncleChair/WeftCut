import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, analyzeColor } from '../lib/analyze.mjs'
import {
  launchApp,
  newProject,
  waitForHook,
  driveExport,
  importAndPlaceMedia,
} from './helpers/driver'

// ProRes fidelity gates on the export decode engine
// (docs/superpowers/specs/2026-07-16-export-decode-engine-design.md, Testing
// Decisions). Two proofs of the native lane's reason to exist on a
// WebCodecs-blind source:
//   A. color — a color-tagged ProRes chart exported through the PINNED native
//      route keeps the bt709/limited 4-tuple and shows the source's colors.
//   B. differential — ONE timeline exported twice, flipping only the decode
//      pin (ffmpeg vs webcodecs): SSIM(native, source) > SSIM(proxy, source).
//      Structural guarantee: the proxy leg pays two lossy generations
//      (ProRes → proxy encode → export encode), the native leg one.
// Same run requirements as export-native-wedges.spec.ts: a VITE_WEFTCUT_E2E=1
// build, WEFTCUT_DECODE_E2E=1, and the built native-decode component.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
// 10 s @ 30 fps testsrc2 ProRes — the frame counters give analyze()'s
// best-match alignment real teeth on the differential legs.
const PRORES = path.resolve(MEDIA_DIR, 'test_1080p_30fps_prores.mov')
// 1 s color-chart ProRes (bt709/limited, yuv422p10le; generate.go
// --color-prores) — same chart + manifest as the axis-A 709ltd fixture.
const CHART_PRORES = path.resolve(MEDIA_DIR, 'test_1080p_color_709ltd_prores.mov')
const MANIFEST = path.resolve(MEDIA_DIR, 'color_manifest.json')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-prores-fidelity-proj')
const OUT_COLOR = path.resolve(os.tmpdir(), 'weftcut-e2e-pf-color.mp4')
const OUT_NATIVE = path.resolve(os.tmpdir(), 'weftcut-e2e-pf-native.mp4')
const OUT_PROXY = path.resolve(os.tmpdir(), 'weftcut-e2e-pf-proxy.mp4')

// Component presence (same level-0 probe as export-native-wedges.spec.ts):
// without the built addon the app cannot open native sessions, so the gates
// skip rather than fail. Windows-only today.
const DECODE_ADDON = path.resolve(__dirname, '../../native/decode/index.win32-x64-msvc.node')
const COMPONENT_PRESENT = process.platform === 'win32' && existsSync(DECODE_ADDON)

// Identity samples on this ProRes master measure SSIM ≈ 0.57–0.63 against a
// default-bitrate H.264 re-encode (see export-native-wedges.spec.ts), so the
// floor only rejects garbage; the fidelity verdict is the differential below.
const SSIM_FLOOR = 0.5
// Sampled across the whole 300-frame body; highest center keeps the ±2
// best-match window inside the source (287 <= 299).
const SAMPLES = [30, 90, 150, 210, 285]

// Patch-center app-error ceiling in 8-bit code units. The committed axis-A
// baseline holds exports of the H.264 charts to faithfulMax=5
// (e2e/fixtures/color_baseline.json); this chain additionally pays the ProRes
// master's 10-bit→8-bit requantization and the I420 transport's 4:2:2→4:2:0
// chroma resampling (≈1–2 extra steps on flat patch centers), hence the
// modest headroom. The failure this guards — a wrong matrix/range in the
// native decode — reads as tens of steps on the saturated patches.
const COLOR_APP_MAX = 8

interface NativePerf {
  totalFrames: number
  totalDispatched: number
  nativeHandles: number
}

async function bootProject(page: Page, prefix: string): Promise<void> {
  await newProject(page, {
    parentFolder: PROJECT_PARENT,
    name: prefix + Date.now(),
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
  })
  await waitForHook(page, 'exportTimeline')
}

async function readPerf(page: Page): Promise<NativePerf> {
  const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
    | NativePerf
    | null
  if (!perf) throw new Error('export settled but __weftcutExportPerf is missing (VITE_WEFTCUT_E2E build?)')
  return perf
}

// Local clone of export_codecs.spec.ts's ffprobe helper — importing a spec
// file would register its tests into this one, so the few lines are
// duplicated. Throws when ffprobe is missing or fails: the color-tag
// assertions must not silently skip.
function probeVideoStream(file: string, entries: string): Record<string, string> {
  const r = spawnSync(
    'ffprobe',
    [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', `stream=${entries}`,
      '-of', 'default=nw=1', file,
    ],
    { encoding: 'utf8' },
  )
  if (r.error) {
    throw new Error('ffprobe not available on PATH (required for color-tag verification): ' + r.error.message)
  }
  if (r.status !== 0) {
    throw new Error('ffprobe failed (status ' + r.status + ') on ' + file + ': ' + r.stderr)
  }
  const out: Record<string, string> = {}
  for (const line of r.stdout.trim().split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

// Local re-implementation of src/main/state/canonical.ts::sortKeys (importing
// across the main-process boundary would drag that tsconfig project into a
// spec): recursively sort object keys, arrays keep order, every VALUE stays
// verbatim. LANDMINE: never "upgrade" this to a canonicalize()-style
// normalizer — a differential gate that normalizes a field on both sides is
// blind to that field's real value, and this gate exists to SEE the raw
// per-sample ssim/psnr measurements differ between the two pins.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key])
    return out
  }
  return value
}

async function runTimelineExport(
  page: Page,
  output: string,
  settings: Record<string, unknown>,
  timeoutMs: number,
): Promise<NativePerf> {
  rmSync(output, { force: true })
  const r = await driveExport(
    page,
    { outputAbsPath: output, settings },
    { hook: 'exportTimeline', timeout: timeoutMs },
  )
  if (!r.done.ok) throw new Error('exportTimeline failed: ' + r.done.error)
  // __weftcutExportPerf is (re)published on each export's `done` message
  // (worker/runExport.ts), so it must be read here, before the next export
  // overwrites it.
  return readPerf(page)
}

test.describe('export ProRes fidelity gates (Electron)', () => {
  test.skip(
    process.env.WEFTCUT_DECODE_E2E !== '1',
    'ProRes fidelity gates are local-only (need the native-decode component + a VITE_WEFTCUT_E2E=1 build); set WEFTCUT_DECODE_E2E=1 to run',
  )
  test.skip(!COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native sessions`)
  test.skip(!existsSync(PRORES), `ProRes fixture not found at ${PRORES} (set WEFTCUT_TEST_MEDIA / npm run fixtures)`)

  test.beforeAll(() => {
    mkdirSync(PROJECT_PARENT, { recursive: true })
  })

  // Gate A: the color half — the chart's colors and its
  // bt709/limited interpretation must survive native decode → composite →
  // default (native-sink) H.264 encode. nativeHandles guards against a silent
  // WebCodecs fallback making the whole gate vacuous.
  test('native-pinned ProRes chart export keeps color tags and patch colors', async () => {
    test.skip(!existsSync(CHART_PRORES), `ProRes chart fixture not found at ${CHART_PRORES} (npm run fixtures)`)
    test.skip(!existsSync(MANIFEST), `color manifest not found at ${MANIFEST} (npm run fixtures)`)
    test.setTimeout(420_000)
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-pf-color-')
      await importAndPlaceMedia(page, { mediaAbsPath: CHART_PRORES, tStartUs: 0 })
      const perf = await runTimelineExport(page, OUT_COLOR, { decodeEngine: 'ffmpeg' }, 400_000)
      expect(perf.nativeHandles, 'ffmpeg pin must engage the native session').toBeGreaterThanOrEqual(1)
      expect(perf.totalFrames, '1s @ 30fps chart = 30 frames').toBe(30)
    } finally {
      await app.close()
    }

    // The native encode sink's color contract (videosink.rs writes the
    // explicit 4-tuple; same assertion as export_codecs.spec.ts) — the source
    // chart's tagged interpretation must come out the other end, not a
    // guessed/absent one.
    const st = probeVideoStream(OUT_COLOR, 'pix_fmt,color_space,color_transfer,color_primaries,color_range')
    console.log('[e2e] ProRes chart output tags:', JSON.stringify(st))
    expect(st.color_space).toBe('bt709')
    expect(st.color_transfer).toBe('bt709')
    expect(st.color_primaries).toBe('bt709')
    expect(st.color_range).toBe('tv')

    const report = analyzeColor({
      output: OUT_COLOR,
      source: CHART_PRORES,
      manifest: MANIFEST,
      inMatrix: 'bt709',
      inRange: 'tv',
      sample: 10,
    })
    console.log(`[e2e] ProRes chart color report: worst_app_max=${report.worst_app_max}`)
    const offenders = report.patches.filter(
      (p: any) => Math.max(...(p.app_error.max as number[])) > COLOR_APP_MAX,
    )
    expect(
      offenders,
      JSON.stringify(offenders.map((p: any) => ({ id: p.id, max: p.app_error.max }))),
    ).toHaveLength(0)
    expect(report.worst_app_max).toBeLessThanOrEqual(COLOR_APP_MAX)
  })

  // Gate B: the ticket's reason to exist — one timeline, two exports, only
  // the decode pin flipped. The native leg reads the ProRes original in one
  // generation; the webcodecs leg re-encodes through the full proxy first, so
  // its output must sit strictly farther from the source.
  test('native pin beats the proxy path on SSIM to source (differential)', async ({}, testInfo) => {
    // Two full exports + analysis. The webcodecs leg additionally blocks on
    // the import-time auto-enqueued full ProRes proxy transcode (blind-spot
    // route), so it gets the same 400s driveExport budget as the slow wedge
    // gates and the whole test roughly the sum of both legs.
    test.setTimeout(900_000)
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-pf-diff-')
      await importAndPlaceMedia(page, { mediaAbsPath: PRORES, tStartUs: 0 })

      // Native leg first: it skips the pre-export proxy wait (spec decision
      // 8), and its runtime doubles as head start for the proxy transcode the
      // second leg needs.
      const perfNative = await runTimelineExport(page, OUT_NATIVE, { decodeEngine: 'ffmpeg' }, 400_000)
      expect(perfNative.nativeHandles, 'ffmpeg pin must engage the native session').toBeGreaterThanOrEqual(1)
      expect(perfNative.totalFrames, '10s @ 30fps = 300 frames').toBe(300)

      const perfProxy = await runTimelineExport(page, OUT_PROXY, { decodeEngine: 'webcodecs' }, 400_000)
      expect(perfProxy.nativeHandles, 'webcodecs pin must not open native sessions').toBe(0)
      expect(perfProxy.totalFrames).toBe(300)
    } finally {
      await app.close()
    }

    // Identical analyzer parameters on both legs — any asymmetry here would
    // let the harness, not the pipeline, decide the differential.
    const reportNative = analyze({ output: OUT_NATIVE, source: PRORES, samples: SAMPLES, ssimMin: SSIM_FLOOR })
    const reportProxy = analyze({ output: OUT_PROXY, source: PRORES, samples: SAMPLES, ssimMin: SSIM_FLOOR })

    for (const [label, report] of [['native', reportNative], ['proxy', reportProxy]] as const) {
      const misaligned = report.samples.filter((s: any) => !s.aligned)
      expect(misaligned, `${label}: ` + JSON.stringify(misaligned)).toHaveLength(0)
      const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
      expect(lowSsim, `${label}: ` + JSON.stringify(lowSsim)).toHaveLength(0)
    }

    // Sorted keys, values verbatim (sortKeys above). The non-identity check
    // compares only the per-sample measurements: the full Report embeds the
    // output path, which differs trivially and would make the assertion
    // toothless. Identical measurement sets would mean the differential is
    // comparing values something upstream already normalized away.
    const nativeSamples = JSON.stringify(sortKeys(reportNative.samples))
    const proxySamples = JSON.stringify(sortKeys(reportProxy.samples))
    await testInfo.attach('ssim-native.json', {
      body: JSON.stringify(sortKeys(reportNative), null, 2),
      contentType: 'application/json',
    })
    await testInfo.attach('ssim-proxy.json', {
      body: JSON.stringify(sortKeys(reportProxy), null, 2),
      contentType: 'application/json',
    })
    expect(nativeSamples, 'the two pins must produce measurably different outputs').not.toBe(proxySamples)

    // Strict > with no fixed margin: the one-vs-two-generations structure
    // guarantees the ordering, but the gap size depends on encoder/bitrate
    // choices — a made-up margin would only add flakiness, not teeth.
    const mean = (r: any) =>
      r.samples.reduce((acc: number, s: any) => acc + s.ssim, 0) / r.samples.length
    const meanNative = mean(reportNative)
    const meanProxy = mean(reportProxy)
    console.log(
      `[e2e] mean SSIM to source: native=${meanNative.toFixed(5)} proxy=${meanProxy.toFixed(5)} delta=${(meanNative - meanProxy).toFixed(5)}`,
    )
    expect(
      meanNative,
      `native decode (${meanNative}) must beat the proxy path (${meanProxy}) on mean SSIM to source`,
    ).toBeGreaterThan(meanProxy)
  })
})
