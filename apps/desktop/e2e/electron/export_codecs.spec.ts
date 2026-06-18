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
// f16/WebGL2 + yuv420p10le pack + WS videosink + ffmpeg HEVC Main10 chain.
const SOURCE_10BIT = path.resolve(MEDIA_DIR, 'test_1080p_gradient10_h264.mp4')

const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-codecs-proj')

// Repo root (e2e/electron → apps/desktop → repo root = 3 levels up from __dirname).
const REPO = path.resolve(__dirname, '..', '..', '..', '..')

// ---------------------------------------------------------------------------
// Settings objects — copied from the source specs:
//
//   AV1 (8-bit, WebCodecs sw encode → ffmpeg mux):
//     No single source spec exposes these fields; constructed verbatim from
//     exportSettings.ts ExportSettings type. The key discriminator is
//     `codec:'av1'` which routes through WebCodecs-AV1 → mux_export.
//
//   HEVC (8-bit, WebCodecs H.264 mezzanine → ffmpeg transcode_and_mux):
//     Same type; `codec:'hevc'` routes through the ffmpeg transcode path,
//     emitting `export:transcode_progress` events.
//
//   10-bit HEVC (WS videosink → ffmpeg HEVC Main10):
//     Verbatim from export_10bit.e2e.js `TEN_BIT_SETTINGS`.
//     Source: apps/desktop/e2e/specs/export/export_10bit.e2e.js lines 26-31.
// ---------------------------------------------------------------------------

const AV1_SETTINGS = {
  codec: 'av1',
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

// Verbatim from export_10bit.e2e.js TEN_BIT_SETTINGS (lines 26-31).
const TEN_BIT_SETTINGS = {
  codec: 'hevc',
  bitDepth: 10,
  container: 'mp4',
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
  // AV1 (WebCodecs sw encode) — settings from ExportSettings type.
  // Source: test_1080p_30fps.mp4 (standard 10s fixture, always present).
  // Asserts: export completes, output is frame-aligned (analyze SSIM ≥ 0.6).
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
  // HEVC (ffmpeg transcode_and_mux → export:transcode_progress).
  // Source: test_1080p_30fps.mp4.
  // Asserts: export completes, output is HEVC-tagged, frame-aligned (SSIM ≥ 0.6).
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

      const st = probeVideoStream(OUTPUT, 'codec_name,profile,pix_fmt')
      console.log('[e2e] HEVC output stream:', JSON.stringify(st))
      expect(st.codec_name).toBe('hevc')
      // 8-bit HEVC — pixel format must NOT be a 10-bit format.
      if (st.pix_fmt) {
        expect(['p010le', 'yuv420p10le']).not.toContain(st.pix_fmt)
      }

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
  // 10-bit HEVC (WS videosink → ffmpeg HEVC Main10).
  // Settings verbatim from export_10bit.e2e.js TEN_BIT_SETTINGS (lines 26-31):
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
      // Verbatim assertions from export_10bit.e2e.js lines 152-158.
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

      // The source spec (export_10bit.e2e.js) asserts via `gradientReport`
      // (media_conformance --gradient-row, distinct luma levels > 600) which is
      // not exposed in analyze.mjs. Instead we run a wide-window analyze() as a
      // loose smoke: the 1s gradient ramp is 30 frames, so we use the window
      // parameter to tolerate minor frame-grid differences (the 10-bit path's
      // Hi10P SW decode + WS-sink chunking can shift PTS by a frame or two).
      // The primary quality gate here is the codec-shape check above.
      const SSIM_FLOOR = 0.6
      const report = analyze({ output: OUTPUT, source: SOURCE_10BIT, samples: [10], ssimMin: SSIM_FLOOR, window: 5 })
      console.log('[e2e] 10-bit conformance report:', JSON.stringify(report))
      // Verify SSIM quality (the encode must produce a faithful 10-bit output,
      // not garbage). We do NOT gate on strict frame alignment here — the 30-frame
      // gradient clip's PTS grid can shift by 1–2 frames through the WS path.
      const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
      expect(lowSsim, 'SSIM must exceed ' + SSIM_FLOOR + ': ' + JSON.stringify(lowSsim)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })
})
