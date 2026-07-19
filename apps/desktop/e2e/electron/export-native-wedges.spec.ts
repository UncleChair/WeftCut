import { test, expect, type Page } from '@playwright/test'
import { existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, analyzeGradientRow } from '../lib/analyze.mjs'
import {
  launchApp,
  tmpDir,
  newProject,
  waitForHook,
  driveExport,
  invokeCmd,
  importAndPlaceMedia,
  placeMediaLayer,
  summary,
} from './helpers/driver'

// Wedge-scenario gates on the NATIVE export decode path
// (docs/adr/0033-export-decode-joins-the-engine-overlay.md;
// docs/render.md §Export decode pipelines). The export shapes that
// historically deadlocked or corrupted the
// WebCodecs decode path are replayed against the in-process ffmpeg session
// (`NativeExportSourceHandle` over the frame relay), so the Rust-side
// GOP/EOS/credit logic can never silently regress into the same failures.
//
// Requirements beyond the standard e2e build:
//   - build with VITE_WEFTCUT_E2E=1
//   - run with WEFTCUT_DECODE_E2E=1 + the native-decode component built
// Routing is settings-driven (no build flag): the default `decodeEngine:
// "auto"` routes WebCodecs-blind (native-sw) sources through the native
// session whenever the component is present (resolveExportDecodeRouting).
// Every test asserts `perf.nativeHandles` (rationale on
// `ExportPerf.nativeHandles` in worker/protocol.ts).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
// 10 s @ 30 fps ProRes — WebCodecs-blind, persists decode_route "native-sw",
// which is exactly what the decode-engine resolver routes through the native
// session under `auto` (component present).
const PRORES = path.resolve(MEDIA_DIR, 'test_1080p_30fps_prores.mov')
// 10 s audio-only tones — placed at t=1s it outlasts the 10 s video by 1 s,
// extending the composition grid past the video track's end (EOS-tail shape).
const TONES = path.resolve(MEDIA_DIR, 'test_tones_10s.wav')
// These gates detect wedges (hang / wrong frame / dup tail), not codec
// fidelity: the wedge signal is `aligned`/`best_match_index`. The ProRes
// master carries far more detail than a default-bitrate H.264/AV1 re-encode
// retains — identity samples measure SSIM ≈ 0.57–0.63 on this fixture — so the
// floor only rejects garbage. Fidelity has its own conformance gate (spec
// Testing Decisions, ProRes SSIM + differential).
const SSIM_FLOOR = 0.5
const OFFSET_US = 2_000_000
const OFFSET_FRAMES = 60

// Component presence (level-0 probe, same signal the napi integration test
// uses): without the built addon the app cannot open native sessions, so the
// gates skip rather than fail. The Standard engine's software lane ships on
// all three desktop platforms (issue #5 block B; macOS's ffmpeg-lgpl libs are
// built from source by fetch-ffmpeg-lgpl.mjs), so the gate resolves the
// per-OS addon filename and admits Windows + Linux + macOS (arm64).
const ADDON_FILE = (
  {
    win32: 'index.win32-x64-msvc.node',
    linux: 'index.linux-x64-gnu.node',
    darwin: 'index.darwin-arm64.node',
  } as Partial<Record<NodeJS.Platform, string>>
)[process.platform]
const DECODE_ADDON = ADDON_FILE
  ? path.resolve(__dirname, '../../native/decode', ADDON_FILE)
  : null
const COMPONENT_PRESENT = DECODE_ADDON !== null && existsSync(DECODE_ADDON)

// Deliberately slow consumer for the credit-stall gate: WebCodecs software AV1
// encode (same shape as export_codecs.spec.ts's AV1 cell) can't keep up with
// the native decode, so the ~6-frame credit window saturates.
const AV1_SETTINGS = {
  codec: 'av1',
  encoderEngine: 'webcodecs',
  bitDepth: 8,
  container: 'mp4',
  audio: { include: false },
} as const

interface NativePerf {
  totalFrames: number
  totalDispatched: number
  nativeHandles: number
}

async function bootProject(page: Page, prefix: string): Promise<void> {
  await newProject(page, {
    parentFolder: tmpDir('weftcut-e2e-nw-proj-'),
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

// Import PRORES once at t=0, then place `extras` more copies of the SAME
// mediaId (one fresh track each). Mirrors export_overlap_same_source.spec.ts —
// re-importing would mint a new mediaId and dodge the shared-source decode
// pipeline under test. Deliberately NO wait for the full proxy: native-routed
// blind-spot sources skip the pre-export proxy wait (spec decision 8), so
// exporting straight after placement is itself part of the gate — a routing
// regression that re-enters the proxy wait shows up as an export stuck in
// "preparing" until the ProRes proxy lands (or a driveExport timeout).
async function placeSameSourceClips(page: Page, extras: number[]): Promise<{ mediaId: string }> {
  const first = await importAndPlaceMedia(page, { mediaAbsPath: PRORES, tStartUs: 0 })
  for (const tStartUs of extras) {
    await placeMediaLayer(page, { mediaId: first.mediaId, tStartUs })
  }
  return { mediaId: first.mediaId }
}

// Precondition, not the gate: ProRes must persist the WebCodecs-blind route —
// a misclassification here would otherwise surface as the harder-to-read
// nativeHandles assertion downstream. The verdict lands ASYNCHRONOUSLY
// shortly after import (the native SW-decode capability probe classifies the
// format class, then the route upgrades proxied → native-sw), so poll rather
// than assert a snapshot. This waits for CLASSIFICATION only — the full-proxy
// build stays unawaited (the wait-skip is part of what these gates exercise).
async function expectNativeRoute(page: Page, mediaId: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  let route: string | null = null
  for (;;) {
    route = (await page.evaluate(
      (id) => (window as any).__weftcutTest.mediaDecodeRouteKind(id),
      mediaId,
    )) as string | null
    if (route === 'native-sw' || Date.now() - started >= timeoutMs) break
    await new Promise((r) => setTimeout(r, 250))
  }
  expect(route, 'ProRes must persist decode_route "native-sw"').toBe('native-sw')
}

async function runTimelineExport(page: Page, output: string, timeoutMs: number): Promise<NativePerf> {
  rmSync(output, { force: true })
  const r = await driveExport(page, { outputAbsPath: output }, { hook: 'exportTimeline', timeout: timeoutMs })
  if (!r.done.ok) throw new Error('exportTimeline failed: ' + r.done.error)
  return readPerf(page)
}

// The track currently holding `layerId` — move_layer requires an explicit
// destination track (undefined newTrackId is a structured TrackNotFound).
async function trackIdOf(page: Page, layerId: string): Promise<string> {
  const s = await summary(page)
  const t = s.tracks.find((tr) => tr.layers.some((l) => l.id === layerId))
  if (!t) throw new Error(`layer ${layerId} not found in project summary`)
  return t.id
}

interface LayerShape {
  t_start_us: number
  t_end_us: number
  params: { kind: string; src_in_us?: number; src_out_us?: number }
}

async function layerShape(page: Page, layerId: string): Promise<LayerShape> {
  const s = await summary(page)
  for (const tr of s.tracks) {
    for (const l of tr.layers) {
      if (l.id === layerId) return l as unknown as LayerShape
    }
  }
  throw new Error(`layer ${layerId} not found in project summary`)
}

function assertIdentityAligned(report: any, floor = SSIM_FLOOR): void {
  const misaligned = report.samples.filter((s: any) => !s.aligned)
  expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
  const lowSsim = report.samples.filter((s: any) => s.ssim < floor)
  expect(lowSsim, JSON.stringify(lowSsim)).toHaveLength(0)
}

test.describe('native export decode wedge gates (Electron)', () => {
  // Dispatch reference recorded by the baseline test, consumed by the stacked
  // overlap test (workers: 1 — file order is execution order).
  let baselineDispatched: number | null = null

  test.skip(
    process.env.WEFTCUT_DECODE_E2E !== '1',
    'native export wedge gates are local-only (need the native-decode component + a VITE_WEFTCUT_E2E=1 build); set WEFTCUT_DECODE_E2E=1 to run',
  )
  test.skip(!COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native sessions`)
  test.skip(!existsSync(PRORES), `ProRes fixture not found at ${PRORES} (set WEFTCUT_TEST_MEDIA / npm run fixtures)`)

  // Gate (a): the plain single-clip shape — proves the native session decodes
  // the whole file frame-exact before the wedge shapes stack on top.
  test('baseline: a single native ProRes clip exports clean (dispatch reference)', async () => {
    test.setTimeout(420_000)
    const OUT_BASELINE = path.join(tmpDir('weftcut-e2e-nw-out-'), 'baseline.mp4')
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-nw-base-')
      const r = await driveExport(
        page,
        { mediaAbsPath: PRORES, outputAbsPath: OUT_BASELINE },
        { hook: 'exportClip', timeout: 400_000 },
      )
      if (!r.done.ok) throw new Error('exportClip failed: ' + r.done.error)
      const perf = await readPerf(page)
      expect(perf.nativeHandles, 'native path must engage (decode-engine resolver routing?)').toBeGreaterThanOrEqual(1)
      expect(perf.totalFrames, '10s @ 30fps ProRes = 300 frames').toBe(300)
      baselineDispatched = perf.totalDispatched
      const report = analyze({ output: OUT_BASELINE, source: PRORES, samples: [30, 150, 290], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(report)
      expect(report.pass).toBe(true)
    } finally {
      await app.close()
    }
  })

  // Gate (b): stacked same-phase clips of one source — the frozen-frame-counter
  // wedge (interleaved decodeRange on a shared pipeline) plus the double-decode
  // regression: same-phase clips must share ONE native session.
  test('two stacked same-source clips export without wedging or extra native decode', async () => {
    test.setTimeout(420_000)
    const OUT_STACKED = path.join(tmpDir('weftcut-e2e-nw-out-'), 'stacked.mp4')
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-nw-stack-')
      const { mediaId } = await placeSameSourceClips(page, [0])
      await expectNativeRoute(page, mediaId)
      const perf = await runTimelineExport(page, OUT_STACKED, 400_000)
      expect(perf.nativeHandles, 'native path must engage').toBeGreaterThanOrEqual(1)
      expect(perf.totalFrames).toBe(300)
      const report = analyze({ output: OUT_STACKED, source: PRORES, samples: [30, 150, 290], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(report)
      expect(report.pass).toBe(true)
      // A filtered/sharded run without the baseline gate has no reference —
      // skip the ceiling rather than fail vacuously (the wedge assertions
      // above already ran).
      test.skip(baselineDispatched == null, 'baseline dispatch reference missing (baseline gate did not run)')
      const ceiling = Math.ceil((baselineDispatched as number) * 1.25)
      expect(perf.totalDispatched, `stacked same-phase clips share one native session (<= ${ceiling})`).toBeLessThanOrEqual(ceiling)
    } finally {
      await app.close()
    }
  })

  // Gate (c): same source at two PHASES — each phase group gets its own native
  // session and neither clip's frames contaminate the other's (the same-source
  // overlap corruption wedge). In the overlap region the offset copy is on top,
  // so output frame 200 must best-match source frame 140.
  test('a 2s-offset same-source overlap exports with both clips on their own frames', async () => {
    test.setTimeout(420_000)
    const OUT_OFFSET = path.join(tmpDir('weftcut-e2e-nw-out-'), 'offset.mp4')
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-nw-offset-')
      const { mediaId } = await placeSameSourceClips(page, [OFFSET_US])
      await expectNativeRoute(page, mediaId)
      const perf = await runTimelineExport(page, OUT_OFFSET, 400_000)
      expect(perf.nativeHandles, 'each phase group gets its own native session').toBeGreaterThanOrEqual(2)
      expect(perf.totalFrames, '12s composition = 360 frames').toBe(360)
      const headReport = analyze({ output: OUT_OFFSET, source: PRORES, samples: [30], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(headReport)
      const tail = analyze({ output: OUT_OFFSET, source: PRORES, samples: [200], window: OFFSET_FRAMES + 2 })
      const s = tail.samples[0]
      expect(s.best_match_index, `output 200 best-matches source ${200 - OFFSET_FRAMES}`).toBe(200 - OFFSET_FRAMES)
    } finally {
      await app.close()
    }
  })

  // Gate (d): backward clip-reuse jump — the same media placed LATER on the
  // timeline at an EARLIER source time. Clip 1 = source tail [6..10s] at t=0,
  // clip 2 = source head [0..4s] at t=4s; the re-seek to the earlier source
  // time must deliver the head frames, not stale tail frames.
  test('a backward clip-reuse jump re-seeks and delivers the earlier source frames', async () => {
    test.setTimeout(420_000)
    const OUT_BACKWARD = path.join(tmpDir('weftcut-e2e-nw-out-'), 'backward.mp4')
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-nw-backward-')
      const { mediaId, layerId: clip1 } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES, tStartUs: 0 })
      // Clip 1 → source tail: trim IN to 6s (t/src move together), then move
      // the layer back to t=0 (timeline-only shift) ⇒ t=[0..4s], src=[6..10s].
      await invokeCmd(page, 'trim_layer', { layerId: clip1, edge: 'in', newTUs: 6_000_000 })
      const track1 = await trackIdOf(page, clip1)
      await invokeCmd(page, 'move_layer', { layerId: clip1, newTrackId: track1, newTStartUs: 0 })
      // Clip 2 → source head on a fresh track: place 1:1 at t=4s, trim OUT to
      // 8s ⇒ t=[4..8s], src=[0..4s].
      const { layerId: clip2 } = await placeMediaLayer(page, { mediaId, tStartUs: 4_000_000 })
      await invokeCmd(page, 'trim_layer', { layerId: clip2, edge: 'out', newTUs: 8_000_000 })

      // Guard the layout landed exactly — a silently clamped trim/move would
      // shift every expectation below.
      const s1 = await layerShape(page, clip1)
      expect([s1.t_start_us, s1.t_end_us, s1.params.src_in_us, s1.params.src_out_us]).toEqual([
        0, 4_000_000, 6_000_000, 10_000_000,
      ])
      const s2 = await layerShape(page, clip2)
      expect([s2.t_start_us, s2.t_end_us, s2.params.src_in_us, s2.params.src_out_us]).toEqual([
        4_000_000, 8_000_000, 0, 4_000_000,
      ])

      await expectNativeRoute(page, mediaId)
      const perf = await runTimelineExport(page, OUT_BACKWARD, 400_000)
      expect(perf.nativeHandles, 'two phases = two native sessions').toBeGreaterThanOrEqual(2)
      expect(perf.totalFrames, '8s composition = 240 frames').toBe(240)

      // Clip-2 region: output 150 (t=5s) maps to source 30 (offset −120) —
      // the re-seek to the EARLIER source time must deliver head frames.
      const head = analyze({ output: OUT_BACKWARD, source: PRORES, samples: [150], window: 122 })
      expect(head.samples[0].best_match_index, 'output 150 best-matches source 30 (clip 2, source head)').toBe(30)
      // Clip-1 region: output 30 (t=1s) maps to source 210 (offset +180) —
      // the tail segment decoded first must not have been contaminated.
      const tail = analyze({ output: OUT_BACKWARD, source: PRORES, samples: [30], window: 182 })
      expect(tail.samples[0].best_match_index, 'output 30 best-matches source 210 (clip 1, source tail)').toBe(210)
    } finally {
      await app.close()
    }
  })

  // Gate (e): EOS tail — the composition grid extends 1 s past the video's end
  // (audio outlasts video), so the native session hits true EOS and the drain
  // must clamp instead of hanging. Exact totalFrames catches the hang shape
  // (the historical deadlock pinned the frame counter); samples at the video's
  // final frames catch an early clamp (Ended overtaking the tail frames dups
  // them from an earlier frame → misaligned).
  test('EOS tail past the video content completes with the exact tail frame count', async () => {
    test.skip(!existsSync(TONES), `tones fixture not found at ${TONES} (set WEFTCUT_TEST_MEDIA / npm run fixtures)`)
    test.setTimeout(420_000)
    const OUT_EOS = path.join(tmpDir('weftcut-e2e-nw-out-'), 'eostail.mp4')
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-nw-eostail-')
      const { mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES, tStartUs: 0 })
      // 10 s tones at t=1s ⇒ audio spans [1..11s], outlasting the 10 s video;
      // composition duration autofits to 11 s.
      await importAndPlaceMedia(page, { mediaAbsPath: TONES, tStartUs: 1_000_000 })
      await expectNativeRoute(page, mediaId)
      const perf = await runTimelineExport(page, OUT_EOS, 400_000)
      expect(perf.nativeHandles, 'native path must engage').toBeGreaterThanOrEqual(1)
      expect(perf.totalFrames, 'audio-extended 11s composition plans 330 frames').toBe(330)
      // 285/293/297 sit in the last GOP-and-a-bit before the video's end —
      // squarely where an early clamp dups frames; 30/150 anchor the body.
      // The analyzer's best-match window is ±2 with no clamp at the source's
      // end, so the highest sample must keep center+2 <= 299; frames 300+ are
      // past the video track and not sampled.
      const report = analyze({ output: OUT_EOS, source: PRORES, samples: [30, 150, 285, 293, 297], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(report)
      expect(report.pass).toBe(true)
    } finally {
      await app.close()
    }
  })

  // Gate (f): slow-consumer credit stall — WebCodecs software AV1 encode can't
  // keep up with native decode, so the ~6-frame credit window saturates; the
  // producer must park and resume without deadlock (a wedge surfaces as the
  // driveExport timeout). Deterministic window-saturation/resume proof lives at
  // the napi seam (export-decode-native.integration.test.ts, window=3); this
  // gate proves the full app under sustained backpressure.
  test('slow-consumer credit stall: AV1 software encode completes without deadlock', async () => {
    test.setTimeout(600_000)
    const OUT_AV1 = path.join(tmpDir('weftcut-e2e-nw-out-'), 'av1.mp4')
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-nw-av1-')
      const r = await driveExport(
        page,
        { mediaAbsPath: PRORES, outputAbsPath: OUT_AV1, settings: AV1_SETTINGS },
        { hook: 'exportClip', timeout: 580_000 },
      )
      if (!r.done.ok) throw new Error('exportClip failed: ' + r.done.error)
      const perf = await readPerf(page)
      expect(perf.nativeHandles, 'native path must engage').toBeGreaterThanOrEqual(1)
      expect(perf.totalFrames).toBe(300)
      const report = analyze({ output: OUT_AV1, source: PRORES, samples: [30, 150, 290], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(report)
      expect(report.pass).toBe(true)
    } finally {
      await app.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Ramp precision gates: the native 10-bit lane (I420P10 transport).
// A true-10-bit gradient ramp (test_1080p_gradient10_h264.mp4 — H.264 Hi10P,
// horizontal 0..1023 luma sweep, bt709/limited; generate.mjs --gradient-h264)
// exports through the PINNED native decode route (`decodeEngine: "ffmpeg"`)
// to a 10-bit target, and the analyzer's --gradient-row mode proves the
// ramp's step count survived: an 8-bit-banded lane caps at <=256 distinct
// levels, the clean 10-bit lane measures ~880 (raw fixture: 879 distinct /
// max plateau 151).
//
// Plateau semantics (banding_stats unit tests, media_conformance.rs): a clean
// ramp reads plateau ~1, an 8-bit-quantized one ~4x wider. On THESE fixtures
// the whole-row max plateau is structurally ~151 either way: the ramp's
// 0..1023 code sweep exceeds the limited-range window, so the analyzer's
// forced bt709/tv decode clips both ends into long constant runs that swamp
// the mid-ramp plateau signal. distinct_levels therefore carries the banding
// verdict; the plateau ceiling only rejects a flat/garbage row (a clearer
// failure readout than levels alone).
//
// Deliberately NOT asserted: the I420P10 transport is
// 4:2:0, so a 4:2:2/4:4:4 source loses chroma resolution through the native
// lane. That 422->420 chroma cost is a documented v2 limitation, not a v1
// promise — these gates assert LUMA ramp precision only (the fixture's chroma
// is constant 512, neutral gray).
// ---------------------------------------------------------------------------

// 1 s static 10-bit ramp — H.264 Hi10P, the primary 10-bit source shape.
const GRADIENT10 = path.resolve(MEDIA_DIR, 'test_1080p_gradient10_h264.mp4')

// >600 of 1023 distinct levels: clean lane measures ~880, an 8-bit-banded
// lane caps at <=256 — the gate separates by >2x in both directions.
const RAMP_MIN_DISTINCT = 600
// ~2x the structural end-clip plateau (151 on the raw fixture) — headroom for
// encoder drift while still rejecting a flat/garbage row.
const RAMP_MAX_PLATEAU = 300

// `decodeEngine: "ffmpeg"` pins EVERY source onto the native session — an
// explicit fidelity promise with no fallbacks (exportDecodeRouting.ts) — so a
// routing regression fails the nativeHandles assertion instead of passing
// silently via WebCodecs. bitDepth 10 selects the I420P10 transport, the f16
// composite, and the native 10-bit encode (encoderEngine "auto" resolves
// native; a webcodecs pin is invalid at depth 10 — mergeSettings).
const RAMP10_HEVC_SETTINGS = {
  codec: 'hevc',
  bitDepth: 10,
  container: 'mp4',
  decodeEngine: 'ffmpeg',
  audio: { include: false },
} as const

// Same lane, the second tenBitExportCapable target. A separate test so the
// slower AV1 software encode can be sharded or skipped independently of HEVC.
const RAMP10_AV1_SETTINGS = {
  codec: 'av1',
  bitDepth: 10,
  container: 'mp4',
  decodeEngine: 'ffmpeg',
  audio: { include: false },
} as const

// Local clone of export_codecs.spec.ts's ffprobe helper — importing a spec
// file would register its tests into this one, so the few lines are
// duplicated. Throws when ffprobe is missing or fails: the codec-shape
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
    throw new Error('ffprobe not available on PATH (required for codec verification): ' + r.error.message)
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

interface RampBanding {
  distinct_levels: number
  max_plateau: number
}

// The ramp is neutral gray (cb=cr=512), so R/G/B all follow luma — assert all
// three channels rather than electing one as "the" luma proxy.
function assertRampPrecision(report: { banding: RampBanding[] }, label: string): void {
  for (const [i, ch] of report.banding.entries()) {
    expect(
      ch.distinct_levels,
      `${label} channel ${i}: distinct 10-bit levels (>${RAMP_MIN_DISTINCT} of 1023; 8-bit banding caps at 256)`,
    ).toBeGreaterThan(RAMP_MIN_DISTINCT)
    expect(
      ch.max_plateau,
      `${label} channel ${i}: max plateau (structural end-clip ~151; a flat/garbage row reads ~1920)`,
    ).toBeLessThanOrEqual(RAMP_MAX_PLATEAU)
  }
}

test.describe('native export 10-bit ramp precision gates (Electron)', () => {
  test.skip(
    process.env.WEFTCUT_DECODE_E2E !== '1',
    'native export ramp gates are local-only (need the native-decode component + a VITE_WEFTCUT_E2E=1 build); set WEFTCUT_DECODE_E2E=1 to run',
  )
  test.skip(!COMPONENT_PRESENT, `native-decode component not built (${DECODE_ADDON}) — the app cannot open native sessions`)
  test.skip(!existsSync(GRADIENT10), `10-bit ramp fixture not found at ${GRADIENT10} (set WEFTCUT_TEST_MEDIA / npm run fixtures)`)

  // Boot a fresh project and export the ramp clip via the REAL exportClip path
  // with the pinned-native 10-bit `settings`; assert the native route actually
  // engaged before returning. Codec-shape + ramp analysis run after the app
  // closes (both shell out — no renderer needed).
  async function exportRampNative(
    prefix: string,
    output: string,
    settings: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<NativePerf> {
    rmSync(output, { force: true })
    const { app, page } = await launchApp()
    // Export failures surface as renderer exportState/console errors, NOT in the
    // workspace JSONL (which stops at decode resolution) — forward them or a
    // failed gate reports only "no output file".
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning')
        console.log(`[app:${m.type()}]`, m.text())
    })
    try {
      await bootProject(page, prefix)
      const r = await driveExport(
        page,
        { mediaAbsPath: GRADIENT10, outputAbsPath: output, settings },
        { hook: 'exportClip', timeout: timeoutMs },
      )
      if (!r.done.ok) throw new Error('exportClip failed: ' + r.done.error)
      const perf = await readPerf(page)
      expect(
        perf.nativeHandles,
        'native path must engage (ffmpeg pin degraded to auto? 10-bit routing guard still interim?)',
      ).toBeGreaterThanOrEqual(1)
      expect(perf.totalFrames, '1s @ 30fps ramp = 30 frames').toBe(30)
      return perf
    } finally {
      await app.close()
    }
  }

  // Gate (g): 10-bit ramp -> native I420P10 decode -> HEVC Main10. The step
  // count surviving into the output proves the lane never dropped to 8 bits
  // anywhere between the ffmpeg session and the encoder.
  test('10-bit ramp through the native route to HEVC Main10 keeps its step count', async () => {
    test.setTimeout(420_000)
    const OUT_RAMP_HEVC = path.join(tmpDir('weftcut-e2e-nw-out-'), 'ramp10-hevc.mp4')
    await exportRampNative('e2e-nw-ramp10-hevc-', OUT_RAMP_HEVC, RAMP10_HEVC_SETTINGS, 400_000)
    const st = probeVideoStream(OUT_RAMP_HEVC, 'codec_name,profile,pix_fmt')
    console.log('[e2e] HEVC-10 ramp output stream:', JSON.stringify(st))
    expect(st.codec_name).toBe('hevc')
    expect(['yuv420p10le', 'p010le']).toContain(st.pix_fmt)
    expect(st.profile).toContain('Main 10')
    // The output decodes under the same forced bt709/tv the fixture was
    // authored with (generate.mjs tags the source; the native sink writes the
    // explicit bt709/limited 4-tuple) — pinning keeps the level count stable.
    const ramp = analyzeGradientRow({ output: OUT_RAMP_HEVC, sample: 10, inMatrix: 'bt709', inRange: 'tv' })
    console.log('[e2e] HEVC-10 ramp report:', JSON.stringify(ramp))
    assertRampPrecision(ramp, 'hevc10')
  })

  // Gate (h): the same ramp to the second 10-bit target, AV1 (the software
  // encoder is probe-picked — see hwencoder.rs software_encoder_candidates). No
  // profile assertion — AV1's "Main" profile covers 10-bit, so pix_fmt is the
  // depth signal.
  test('10-bit ramp through the native route to AV1 10-bit keeps its step count', async () => {
    // AV1 10-bit needs a sidecar built with libsvtav1. Block A pins the Linux
    // sidecar to the BtbN n7.1 GPL build (fetch-ffmpeg.mjs), which carries
    // libsvtav1 (8/10-bit) — so the software-encoder probe picks it and this
    // gate runs on Linux too, alongside Windows.
    test.setTimeout(420_000)
    const OUT_RAMP_AV1 = path.join(tmpDir('weftcut-e2e-nw-out-'), 'ramp10-av1.mp4')
    await exportRampNative('e2e-nw-ramp10-av1-', OUT_RAMP_AV1, RAMP10_AV1_SETTINGS, 400_000)
    const st = probeVideoStream(OUT_RAMP_AV1, 'codec_name,pix_fmt')
    console.log('[e2e] AV1-10 ramp output stream:', JSON.stringify(st))
    expect(st.codec_name).toBe('av1')
    expect(st.pix_fmt).toBe('yuv420p10le')
    const ramp = analyzeGradientRow({ output: OUT_RAMP_AV1, sample: 10, inMatrix: 'bt709', inRange: 'tv' })
    console.log('[e2e] AV1-10 ramp report:', JSON.stringify(ramp))
    assertRampPrecision(ramp, 'av1-10')
  })
})
