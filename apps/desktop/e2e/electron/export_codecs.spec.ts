import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')

// Standard 1080p30 source for AV1 + HEVC 8-bit smoke.
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps.mp4')
// 10-bit H.264 gradient ramp source — proves >256 luma levels survive the
// f16/WebGL2 + yuv420p10le pack + native IPC video sink + ffmpeg HEVC Main10 chain.
const SOURCE_10BIT = path.resolve(MEDIA_DIR, 'test_1080p_gradient10_h264.mp4')

const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-codecs-proj')

// Repo root (e2e/electron → apps/desktop → repo root = 3 levels up from __dirname).
const REPO = path.resolve(__dirname, '..', '..', '..', '..')

// ---------------------------------------------------------------------------
// Export settings per codec. The `codec` field is the routing discriminator.
// E4 flipped `encoderEngine:'auto'` to native-first and Task 16 deleted the
// H.264-mezzanine transcode path (`resolveEncodePath`/`TranscodeSpec`/
// `transcode_and_mux` are gone) — a WebCodecs fallback now only happens via
// an explicit user-consent dialog when the native sink fails to start.
//
//   AV1 (8-bit): `codec:'av1'` + `encoderEngine:'webcodecs'` (explicit pin —
//     under `auto` this would ride native like every other codec below) →
//     WebCodecs sw encode → ffmpeg mux_export. Kept as the living e2e
//     regression guard for the WebCodecs engine, since nothing else here
//     still exercises it.
//
//   HEVC (8-bit): `codec:'hevc'` on `auto` → E4 native-first resolves the
//     ffmpeg video sink directly (no mezzanine, no
//     `export:transcode_progress` events) → PackYuvPlanar yuv420p →
//     chunk/ack IPC → native ffmpeg video sink, tagged with the explicit
//     bt709/limited color 4-tuple like every other native-sink codec below.
//
//   10-bit HEVC: `codec:'hevc'` + `bitDepth:10` → ffmpeg HEVC Main10.
//     See ExportSettings in exportSettings.ts.
//
//   Pinned-native H.264 (8-bit): `codec:'h264'` + `encoderEngine:'native'` →
//     PackYuvPlanar yuv420p → chunk/ack IPC → native ffmpeg video sink
//     (bypasses WebCodecs entirely; asserts explicit bt709/limited color tags).
//
//   ProRes 422 (intermediate, MOV-only): `codec:'prores'` + `proresProfile:'422'`
//     → PackYuvPlanar + f16 10-bit composite → native ffmpeg video sink →
//     prores_ks (-profile:v 2, -vendor apl0) → yuv422p10le in a MOV container.
//
//   DNxHR SQ (intermediate, MOV-only): `codec:'dnxhr'` + `dnxhrProfile:'sq'`
//     → PackYuvPlanar 8-bit composite → native ffmpeg video sink → dnxhd
//     (-profile:v dnxhr_sq) → yuv422p in a MOV container.
// ---------------------------------------------------------------------------

// Explicit WebCodecs pin (E4 changed `auto` to native-first, so this codec
// would otherwise ride the native ffmpeg video sink like HEVC/H.264 below).
// This is the one cell that still exercises the WebCodecs engine end to end —
// its living regression guard, not a routing default any real user hits.
const AV1_SETTINGS = {
  codec: 'av1',
  encoderEngine: 'webcodecs',
  bitDepth: 8,
  container: 'mp4',
  audio: { include: false },
} as const

const HEVC_SETTINGS = {
  codec: 'hevc',
  bitDepth: 8,
  container: 'mp4',
  audio: { include: false },
} as const

// 10-bit HEVC Main10 settings (see ExportSettings in exportSettings.ts).
const TEN_BIT_SETTINGS = {
  codec: 'hevc',
  bitDepth: 10,
  container: 'mp4',
  audio: { include: false },
} as const

// Pinned-native H.264 (8-bit) — encoderEngine:'native' bypasses "auto"
// resolution and forces the ffmpeg video sink lane regardless of machine.
const NATIVE_H264_SETTINGS = {
  codec: 'h264',
  encoderEngine: 'native',
  bitDepth: 8,
  container: 'mp4',
  audio: { include: false },
} as const

// ProRes 422 — intermediate codec, native-only, MOV-only. bitDepth/container
// are implied by isIntermediateCodec + mergeSettings' snap (compositeBitDepth
// forces 10 for ProRes), so they're omitted here like the other settings
// consts omit encoderEngine.
const PRORES_SETTINGS = {
  codec: 'prores',
  proresProfile: '422',
  container: 'mov',
  audio: { include: false },
} as const

// DNxHR SQ — intermediate codec, native-only, MOV-only, 8-bit composite.
const DNXHR_SETTINGS = {
  codec: 'dnxhr',
  dnxhrProfile: 'sq',
  container: 'mov',
  audio: { include: false },
} as const

// ---------------------------------------------------------------------------
// Helper: drive one exportClip and assert it completed.
// ---------------------------------------------------------------------------
async function exportTo(
  page: Page,
  codecLabel: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  const r = await driveExport(page, args, { timeout: timeoutMs })
  if (!r.done.ok) throw new Error(`${codecLabel} export failed: ` + r.done.error)
}

// ---------------------------------------------------------------------------
// ffprobe helper: probe first video stream. Throws when ffprobe is not on PATH
// or exits non-zero — codec-identity assertions must not be silently skipped.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.describe('multi-codec export smoke (Electron)', () => {
  test.beforeAll(() => mkdirSync(PROJECT_PARENT, { recursive: true }))

  // -------------------------------------------------------------------------
  // AV1, pinned `encoderEngine:'webcodecs'` (WebCodecs sw encode → ffmpeg
  // mux_export) — settings from ExportSettings type. Since E4 flipped `auto`
  // to native-first, this explicit pin is what keeps the WebCodecs engine
  // under a living e2e regression guard (everything else in this file now
  // rides the native ffmpeg video sink).
  // Source: test_1080p_30fps.mp4 (standard 10s fixture, always present).
  // Asserts: export completes, output is frame-aligned (analyze SSIM ≥ 0.6).
  // Deliberately does NOT assert the explicit bt709/limited color 4-tuple —
  // that's the native sink's contract; the WebCodecs/mux_export lane relies
  // on implicit/inferred tags instead.
  // -------------------------------------------------------------------------
  test('AV1 export produces an aligned file (Electron)', async () => {
    test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
    test.setTimeout(300000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-av1.mp4')
    rmSync(OUTPUT, { force: true })

    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-av1-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      await exportTo(
        page,
        'AV1',
        { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT, settings: AV1_SETTINGS },
        280000,
      )
      expect(existsSync(OUTPUT), 'AV1 output file must exist').toBe(true)

      // Codec-shape smoke: verify the output is actually AV1.
      const st = probeVideoStream(OUTPUT, 'codec_name')
      console.log('[e2e] AV1 output stream:', JSON.stringify(st))
      expect(st.codec_name).toBe('av1')

      // Frame alignment + SSIM floor. AV1 sw encode is lossy; 0.6 is a loose floor
      // that still catches a gross decode/composite regression (colour-matrix mismatch
      // scored ~0.47 before that fix).
      const SSIM_FLOOR = 0.6
      const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: SSIM_FLOOR })
      console.log('[e2e] AV1 conformance report:', JSON.stringify(report))
      const misaligned = report.samples.filter((s: any) => !s.aligned)
      expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // HEVC on `auto` (E4 native-first → the native ffmpeg video sink directly;
  // the H.264-mezzanine transcode_and_mux path Task 16 deleted no longer
  // exists, so this no longer emits export:transcode_progress).
  // Source: test_1080p_30fps.mp4.
  // Asserts: export completes, output is HEVC-tagged + 8-bit, carries the
  // explicit bt709/limited color 4-tuple (the native sink's assertable
  // color-tagging contract, same as the pinned-native H.264 cell below), and
  // is frame-aligned (SSIM ≥ 0.6).
  // -------------------------------------------------------------------------
  test('HEVC export produces an aligned file (Electron)', async () => {
    test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
    test.setTimeout(300000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-hevc.mp4')
    rmSync(OUTPUT, { force: true })

    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-hevc-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      await exportTo(
        page,
        'HEVC',
        { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT, settings: HEVC_SETTINGS },
        280000,
      )
      expect(existsSync(OUTPUT), 'HEVC output file must exist').toBe(true)

      const st = probeVideoStream(
        OUTPUT,
        'codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,color_range',
      )
      console.log('[e2e] HEVC output stream:', JSON.stringify(st))
      expect(st.codec_name).toBe('hevc')
      // 8-bit HEVC — pixel format must NOT be a 10-bit format.
      if (st.pix_fmt) {
        expect(['p010le', 'yuv420p10le']).not.toContain(st.pix_fmt)
      }
      // Native-sink codecs all get the explicit bt709/limited 4-tuple
      // (setparams + -colorspace/-color_primaries/-color_trc/-color_range in
      // videosink.rs) — HEVC-on-auto is no exception now that it rides the
      // native sink instead of the deleted mezzanine.
      expect(st.color_space).toBe('bt709')
      expect(st.color_transfer).toBe('bt709')
      expect(st.color_primaries).toBe('bt709')
      expect(st.color_range).toBe('tv')

      const SSIM_FLOOR = 0.6
      const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: SSIM_FLOOR })
      console.log('[e2e] HEVC conformance report:', JSON.stringify(report))
      const misaligned = report.samples.filter((s: any) => !s.aligned)
      expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 10-bit HEVC (native IPC video sink → ffmpeg HEVC Main10).
  //   { codec:"hevc", bitDepth:10, container:"mp4", audio:{include:false} }
  // Source: test_1080p_gradient10_h264.mp4 (10-bit H.264 Hi10P gradient ramp).
  // Asserts: export completes, output is HEVC Main10 / 10-bit pix_fmt, file exists.
  // Note: SSIM comparison against a 10-bit source via the 8-bit media_conformance
  // analyzer is indicative only — the gradient-row distinct-level check (proving
  // >600 of 1023 luma levels survived) requires --gradient-row which is not
  // exposed in analyze.mjs. The smoke here proves pipeline completion +
  // codec-shape (hevc / yuv420p10le or p010le / Main 10 profile).
  // -------------------------------------------------------------------------
  test('10-bit HEVC export completes with correct codec shape (Electron)', async () => {
    test.skip(
      !existsSync(SOURCE_10BIT),
      `10-bit source not found at ${SOURCE_10BIT} (set WEFTCUT_TEST_MEDIA or run generate-fixtures.mjs)`,
    )
    test.setTimeout(600000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-10bit.mp4')
    rmSync(OUTPUT, { force: true })

    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-10bit-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      await exportTo(
        page,
        '10-bit HEVC',
        { mediaAbsPath: SOURCE_10BIT, outputAbsPath: OUTPUT, settings: TEN_BIT_SETTINGS },
        560000,
      )
      expect(existsSync(OUTPUT), '10-bit output file must exist').toBe(true)

      // Container/codec shape: HEVC Main10, a 10-bit pixel format.
      const st = probeVideoStream(
        OUTPUT,
        'codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,color_range',
      )
      console.log('[e2e] 10-bit output stream:', JSON.stringify(st))
      expect(st.codec_name).toBe('hevc')
      expect(['yuv420p10le', 'p010le']).toContain(st.pix_fmt)
      expect(st.profile).toContain('Main 10')
      expect(st.color_space).toBe('bt709')
      expect(st.color_transfer).toBe('bt709')
      expect(st.color_primaries).toBe('bt709')
      expect(st.color_range).toBe('tv')

      // A strict gradient-row check (media_conformance --gradient-row, distinct
      // luma levels > 600) is not exposed in analyze.mjs. Instead we run a
      // wide-window analyze() as a
      // loose smoke: the 1s gradient ramp is 30 frames, so we use the window
      // parameter to tolerate minor frame-grid differences (the 10-bit path's
      // Hi10P SW decode + the chunked video-sink path can shift PTS by a frame or two).
      // The primary quality gate here is the codec-shape check above.
      const SSIM_FLOOR = 0.6
      const report = analyze({ output: OUTPUT, source: SOURCE_10BIT, samples: [10], ssimMin: SSIM_FLOOR, window: 5 })
      console.log('[e2e] 10-bit conformance report:', JSON.stringify(report))
      // Verify SSIM quality (the encode must produce a faithful 10-bit output,
      // not garbage). We do NOT gate on strict frame alignment here — the 30-frame
      // gradient clip's PTS grid can shift by 1–2 frames through the video-sink path.
      const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
      expect(lowSsim, 'SSIM must exceed ' + SSIM_FLOOR + ': ' + JSON.stringify(lowSsim)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // Pinned-native H.264 (encoderEngine:'native' → PackYuvPlanar yuv420p →
  // chunk/ack IPC → ffmpeg video sink, bypassing WebCodecs entirely).
  // Source: test_1080p_30fps.mp4.
  // Asserts: export completes, output is h264/yuv420p, EXPLICIT bt709/limited
  // color tags (the native sink's assertable color-tagging contract), and
  // frame-aligned (SSIM ≥ 0.6).
  // -------------------------------------------------------------------------
  test('pinned-native H.264 export is conformant with explicit color tags (Electron)', async () => {
    test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
    test.setTimeout(300000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-native-h264.mp4')
    rmSync(OUTPUT, { force: true })

    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-native-h264-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      await exportTo(
        page,
        'native H.264',
        { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT, settings: NATIVE_H264_SETTINGS },
        280000,
      )
      expect(existsSync(OUTPUT), 'native H.264 output file must exist').toBe(true)

      // Codec shape + the EXPLICIT bt709/limited 4-tuple — the native ffmpeg
      // video sink's assertable color-tagging contract (as opposed to the
      // WebCodecs/mux_export lane, which relies on implicit/inferred tags).
      const st = probeVideoStream(
        OUTPUT,
        'codec_name,pix_fmt,color_space,color_transfer,color_primaries,color_range',
      )
      console.log('[e2e] native H.264 output stream:', JSON.stringify(st))
      expect(st.codec_name).toBe('h264')
      expect(st.pix_fmt).toBe('yuv420p')
      expect(st.color_space).toBe('bt709')
      expect(st.color_transfer).toBe('bt709')
      expect(st.color_primaries).toBe('bt709')
      expect(st.color_range).toBe('tv')

      const SSIM_FLOOR = 0.6
      const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: SSIM_FLOOR })
      console.log('[e2e] native H.264 conformance report:', JSON.stringify(report))
      const misaligned = report.samples.filter((s: any) => !s.aligned)
      expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // ProRes 422 (intermediate; native ffmpeg video sink, f16 10-bit composite →
  // prores_ks). Source: test_1080p_30fps.mp4.
  // Asserts: export completes, output is prores/yuv422p10le with an explicit
  // tv (limited) color_range in a MOV container, and frame-aligned (SSIM ≥ 0.6).
  // Timeout matches the 10-bit HEVC cell (600000/560000): ProRes composites at
  // 10-bit (same f16/PackYuvPlanar pipeline cost) even though the source here
  // is 8-bit test_1080p_30fps.mp4.
  // -------------------------------------------------------------------------
  test('ProRes 422 export lands in MOV with 10-bit 4:2:2 (Electron)', async () => {
    test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
    test.setTimeout(600000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-prores.mov')
    rmSync(OUTPUT, { force: true })

    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-prores-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      await exportTo(
        page,
        'ProRes',
        { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT, settings: PRORES_SETTINGS },
        560000,
      )
      expect(existsSync(OUTPUT), 'ProRes output file must exist').toBe(true)

      // Codec shape: ProRes 422, 10-bit 4:2:2, explicit limited range (the
      // sink tags every intermediate/delivery codec with the bt709/limited
      // 4-tuple; ProRes further requires the pix_fmt to actually be 10-bit).
      const st = probeVideoStream(OUTPUT, 'codec_name,profile,pix_fmt,color_range')
      console.log('[e2e] ProRes output stream:', JSON.stringify(st))
      expect(st.codec_name).toBe('prores')
      expect(st.pix_fmt).toBe('yuv422p10le')
      expect(st.color_range).toBe('tv')

      const SSIM_FLOOR = 0.6
      const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: SSIM_FLOOR })
      console.log('[e2e] ProRes conformance report:', JSON.stringify(report))
      const misaligned = report.samples.filter((s: any) => !s.aligned)
      expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // DNxHR SQ (intermediate; native ffmpeg video sink, 8-bit composite → dnxhd).
  // Source: test_1080p_30fps.mp4.
  // Asserts: export completes, output is dnxhd/yuv422p (ffprobe reports the
  // codec FAMILY name `dnxhd`, with the specific profile string carrying the
  // "DNXHR SQ" flavor), and frame-aligned (SSIM ≥ 0.6).
  // -------------------------------------------------------------------------
  test('DNxHR SQ export lands in MOV as 8-bit 4:2:2 (Electron)', async () => {
    test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
    test.setTimeout(300000)
    const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-dnxhr.mov')
    rmSync(OUTPUT, { force: true })

    const { app, page } = await launchApp()
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'e2e-dnxhr-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      await exportTo(
        page,
        'DNxHR',
        { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT, settings: DNXHR_SETTINGS },
        280000,
      )
      expect(existsSync(OUTPUT), 'DNxHR output file must exist').toBe(true)

      const st = probeVideoStream(OUTPUT, 'codec_name,profile,pix_fmt')
      console.log('[e2e] DNxHR output stream:', JSON.stringify(st))
      expect(st.codec_name).toBe('dnxhd')
      expect(st.pix_fmt).toBe('yuv422p')
      expect(String(st.profile)).toMatch(/DNXHR SQ/i)

      const SSIM_FLOOR = 0.6
      const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150], ssimMin: SSIM_FLOOR })
      console.log('[e2e] DNxHR conformance report:', JSON.stringify(report))
      const misaligned = report.samples.filter((s: any) => !s.aligned)
      expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })
})
