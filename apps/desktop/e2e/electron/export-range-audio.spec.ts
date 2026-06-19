import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, waitForHook, driveExport, importAndPlaceMedia } from './helpers/driver'

// Runtime smoke for the export-range + audio-settings feature, end-to-end
// through the real renderer + real ffmpeg mux. Reuses the per-second
// tone-marker audio fixture (F_k = 400 + 120k Hz at output second k) so the
// Goertzel can read which source-second each output-second carries — the key
// to proving the audio trim. Local-only (needs `npm run fixtures` + cargo).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const fixture = (name: string) => path.resolve(MEDIA_DIR, name)
const tmpOut = (name: string) => path.resolve(os.tmpdir(), name)
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-range-audio-proj')

// The 30fps tone-marker fixture (shared with audio.spec.ts). Output fps follows
// the 30fps composition, so source second k -> tone F_k = 400 + 120k.
const SOURCE = fixture('test_1080p_30fps_audio.mp4')
// Burned-in-counter video fixture (no audio) — for the software-encode case
// (video frame-alignment + SSIM; hwAccel only affects the video encoder).
const VIDEO_SOURCE = fixture('test_1080p_30fps.mp4')

const toneHz = (second: number) => 400 + 120 * second

/// Poll `pred` until true or `timeoutMs` elapses; throw `msg` on timeout.
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, msg: string) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() > deadline) throw new Error(`timed out: ${msg}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/// Decode a file's audio to mono s16le PCM as a Float32Array in [-1, 1].
/// `media_conformance --audio` can't read a range export (its candidate tones
/// are `400 + 120*outputSecondIndex`, so In-shifted tones fall outside) — a
/// direct Goertzel against the true shifted tones is the right tool.
function extractPcm(file: string, sr = 48000): Float32Array {
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
    throw new Error(`ffmpeg PCM extract failed (${r.status}): ${r.stderr ?? ''}`)
  }
  const n = r.stdout.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = r.stdout.readInt16LE(i * 2) / 32768
  return out
}

/// Goertzel power at `freq` over `samples`.
function goertzelPower(samples: Float32Array, freq: number, sr: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sr)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]! + coeff * s1 - s2
    s2 = s1
    s1 = s
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/// Dominant candidate tone in the 1-second window at `second`.
function dominantTone(pcm: Float32Array, second: number, candidates: number[], sr = 48000): number {
  const seg = pcm.subarray(second * sr, (second + 1) * sr)
  let bestF = candidates[0]!
  let bestP = -Infinity
  for (const f of candidates) {
    const p = goertzelPower(seg, f, sr)
    if (p > bestP) {
      bestP = p
      bestF = f
    }
  }
  return bestF
}

/// ffprobe a file's video keyframe timestamps (seconds, sorted). Returns null
/// when ffprobe isn't on PATH (soft-skip).
function keyframeTimestamps(file: string): number[] | null {
  const r = spawnSync(
    'ffprobe',
    [
      '-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  if (r.error) return null // ffprobe not found
  if (r.status !== 0) throw new Error(`ffprobe keyframes failed: ${r.stderr ?? ''}`)
  return r.stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b)
}

/// ffprobe a file for audio streams. Returns true/false, or null when ffprobe
/// isn't on PATH (caller soft-skips).
function hasAudioStream(file: string): boolean | null {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  )
  if (r.error) return null // ffprobe not found
  return r.stdout.trim().length > 0
}

test.describe('export range + audio settings (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeAll(async () => {
    test.skip(!existsSync(SOURCE), `tone source not found at ${SOURCE} (run \`npm run fixtures\`)`)
    mkdirSync(PROJECT_PARENT, { recursive: true })
    ;({ app, page } = await launchApp())
  })
  test.afterAll(async () => {
    await app?.close()
  })

  /// Boot a fresh 30fps project at `<PROJECT_PARENT>/<namePrefix><now>/` and
  /// wait for the editor hooks to mount. Returns the project directory.
  async function bootProject(namePrefix: string): Promise<string> {
    const name = namePrefix + Date.now()
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name,
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    await waitForHook(page, 'exportClip')
    return path.join(PROJECT_PARENT, name)
  }

  /// Boot a fresh project, drive exportClip, and return `{ perf }` — the
  /// worker's `window.__weftcutExportPerf` (E2E-only), carrying `totalFrames`.
  async function bootAndExport(opts: {
    output: string
    settings?: Record<string, unknown>
    range?: { startUs: number; endUs: number }
    source?: string
  }): Promise<{ perf: { totalFrames: number } | null }> {
    await bootProject('e2e-range-audio-')
    const args: Record<string, unknown> = {
      mediaAbsPath: opts.source ?? SOURCE,
      outputAbsPath: opts.output,
    }
    if (opts.settings) args.settings = opts.settings
    if (opts.range) args.range = opts.range
    const r = await driveExport(page, args)
    if (!r.done.ok) {
      throw new Error(`export failed: ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`)
    }
    const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as {
      totalFrames: number
    } | null
    return { perf }
  }

  test('sub-range export trims both video frame count and audio to the window', async () => {
    test.setTimeout(240000)
    // Window [1s, 3s): 2 s at 30fps = 60 output frames. Audio output-second 0
    // should carry the source's 1 s tone (520 Hz), second 1 the 2 s tone
    // (640 Hz) — proving the audio was trimmed to the In point and rebased to 0.
    const output = tmpOut('weftcut-e2e-range.mp4')
    rmSync(output, { force: true })

    const { perf } = await bootAndExport({ output, range: { startUs: 1_000_000, endUs: 3_000_000 } })

    expect(perf).not.toBeNull()
    expect(perf!.totalFrames).toBe(60)

    const pcm = extractPcm(output)
    const cands = [toneHz(0), toneHz(1), toneHz(2), toneHz(3)] // 400/520/640/760
    expect(dominantTone(pcm, 0, cands)).toBe(toneHz(1)) // source 1 s -> 520 Hz
    expect(dominantTone(pcm, 1, cands)).toBe(toneHz(2)) // source 2 s -> 640 Hz
  })

  test('Opus-in-MKV export is produced and stays audio-faithful', async () => {
    test.setTimeout(240000)
    // Whole-clip export to MKV with Opus: exercises libopus encode -> .mka ->
    // stream-copy into .mkv end to end.
    const output = tmpOut('weftcut-e2e-opus.mkv')
    rmSync(output, { force: true })

    await bootAndExport({ output, settings: { container: 'mkv', audio: { codec: 'opus' } } })

    const report = analyze({ output, source: SOURCE, samples: [0], audio: true })
    console.log('[e2e] opus audio report:', JSON.stringify(report))
    expect(report.samples.filter((s: any) => !s.aligned)).toHaveLength(0)
    expect(Math.abs(report.drift_slope - 1)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(report.offset_ms)).toBeLessThanOrEqual(66)
    expect(report.pass).toBe(true)
  })

  test('mute export produces a video file with no audio track', async () => {
    test.setTimeout(240000)
    const output = tmpOut('weftcut-e2e-mute.mp4')
    rmSync(output, { force: true })

    await bootAndExport({ output, settings: { audio: { include: false } } })

    const audio = hasAudioStream(output)
    test.skip(audio === null, 'ffprobe not on PATH — skipping the no-audio-track assertion')
    expect(audio).toBe(false)
  })

  test('keyframe interval setting controls the GOP cadence', async () => {
    test.setTimeout(240000)
    // Whole-clip export with a 2 s keyframe interval. The WebCodecs path forces
    // a keyframe every round(fps×2) frames, so ffprobe should see keyframes
    // ~2 s apart — clearly not the 1 s default.
    const output = tmpOut('weftcut-e2e-gop.mp4')
    rmSync(output, { force: true })

    await bootAndExport({ output, settings: { keyframeIntervalSec: 2 } })

    const kf = keyframeTimestamps(output)
    test.skip(kf === null, 'ffprobe not on PATH — skipping the keyframe-spacing assertion')
    console.log('[e2e] keyframe timestamps (s):', JSON.stringify(kf))
    expect(kf!.length).toBeGreaterThanOrEqual(3)
    const gaps = kf!.slice(1).map((t, i) => t - kf![i]!).sort((a, b) => a - b)
    const medianGap = gaps[Math.floor(gaps.length / 2)]!
    expect(medianGap).toBeGreaterThan(1.5)
    expect(medianGap).toBeLessThan(2.5)
  })

  test('range export re-conforms only in-range audio after cache invalidation', async () => {
    test.setTimeout(300000)
    // Two distinct audio-only sources: A in the export range, B outside it.
    // Deleting both VCONF files while the store still carries conform_path
    // reproduces the stale-cache shape. The export's audio gate must detect A's
    // invalid cache, re-conform it, and hold the export until it lands; it must
    // NOT touch B — the Rust mix plan window-skips layers the export never reads.
    const WAV = fixture('test_tones_10s.wav')
    const MP3 = fixture('test_tones_10s.mp3')
    test.skip(!existsSync(WAV) || !existsSync(MP3), `tone fixtures not found under ${MEDIA_DIR}`)
    const output = tmpOut('weftcut-e2e-range-conform.m4a')
    rmSync(output, { force: true })

    const projDir = await bootProject('e2e-range-conform-')
    // Documented cache layout (docs/audio.md): Cache/audio/{hash}.conform.
    const audioCacheDir = path.join(projDir, 'Cache', 'audio')
    const conformsIn = () =>
      existsSync(audioCacheDir)
        ? readdirSync(audioCacheDir).filter((f) => f.endsWith('.conform'))
        : []

    const place = async (mediaAbsPath: string, tStartUs: number) => {
      const r = await importAndPlaceMedia(page, { mediaAbsPath, tStartUs })
      expect(r.kind).toBe('Audio')
      return r.mediaId
    }
    await place(WAV, 0)
    await place(MP3, 12_000_000)

    // Both import-time conform jobs land (pending or final names — either counts).
    await waitFor(() => conformsIn().length === 2, 60000, 'import-time conform never landed for both')

    // Invalidate BOTH caches on disk; the store still says "conformed". Retried:
    // a preview Range read can hold a file open for a moment.
    for (const f of conformsIn()) {
      const file = path.join(audioCacheDir, f)
      for (let i = 0; ; i++) {
        try {
          rmSync(file, { force: true })
          break
        } catch (e) {
          if (i >= 20) throw e
          await new Promise((r) => setTimeout(r, 100))
        }
      }
    }
    expect(conformsIn()).toHaveLength(0)

    // Audio-only range export [0, 2s) — covers only the WAV.
    const r = await driveExport(
      page,
      {
        outputAbsPath: output,
        range: { startUs: 0, endUs: 2_000_000 },
        settings: { includeVideo: false, includeAudio: true },
      },
      { hook: 'exportTimeline' },
    )
    if (!r.done.ok) throw new Error(`range-conform export failed: ${r.done.error}`)
    console.log(
      `[e2e] export kind=${r.lastKind}; conform files after export: ${JSON.stringify(conformsIn())}`,
    )

    // Exactly ONE conform regenerated: the gate re-conformed the in-range media
    // and never touched the out-of-range one.
    expect(conformsIn()).toHaveLength(1)

    // And the audio really rendered from the regenerated conform — the WAV's
    // per-second tone markers survive into the output.
    const pcm = extractPcm(output)
    const cands = [toneHz(0), toneHz(1), toneHz(2)]
    expect(dominantTone(pcm, 0, cands)).toBe(toneHz(0))
    expect(dominantTone(pcm, 1, cands)).toBe(toneHz(1))
  })

  test('software encoder export stays frame-aligned with low loss', async () => {
    test.setTimeout(240000)
    // hwAccel:"software" forces the WebCodecs prefer-software H.264 path. Assert
    // it works in the real renderer and stays frame-aligned + faithful (SSIM).
    test.skip(!existsSync(VIDEO_SOURCE), `video source not found at ${VIDEO_SOURCE}`)
    const output = tmpOut('weftcut-e2e-sw.mp4')
    rmSync(output, { force: true })

    await bootAndExport({ output, source: VIDEO_SOURCE, settings: { hwAccel: 'software' } })

    const SSIM_FLOOR = 0.8
    const report = analyze({ output, source: VIDEO_SOURCE, samples: [30, 150, 270], ssimMin: SSIM_FLOOR })
    console.log('[e2e] software-encode report:', JSON.stringify(report))
    expect(report.samples.filter((s: any) => !s.aligned)).toHaveLength(0)
    expect(report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)).toHaveLength(0)
    expect(report.pass).toBe(true)
  })
})
