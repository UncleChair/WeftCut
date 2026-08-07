import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, analyzeAudioEnvelope, analyzeAudioPan } from '../lib/analyze.mjs'
import {
  launchApp,
  newProject,
  driveExport,
  invokeCmd,
  summary,
  importAndPlaceMedia,
  placeMediaLayer,
  tmpDir,
} from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const fixture = (name: string) => path.resolve(MEDIA_DIR, name)

// The 30fps tone-marker fixture (per-second tones F_k = 400 + 120k Hz), shared
// by the envelope + role suites.
const SOURCE = fixture('test_1080p_30fps_audio.mp4')

// Fixtures come from global-setup. The envelope + role suites assert ONLY
// audio, so they export with includeVideo:false — on the GPU-less CI legs the
// incidental 1080p video lane (software raster) was 5-8x the test's real cost.

// ─── 1. Audio conformance matrix ─────────────────────────────────────────────
// Audio conformance across the matrix: source frame rate (video-grid-vs-audio
// sync) x export container (mux path). Each case imports the matching audio
// source (per-second tone markers F_k = 400 + 120k Hz), exports to the target
// container, and verifies per-second alignment + A/V drift + tone SNR via
// `media_conformance --audio`.
// The two axes are independent — fps exercises the video-grid-vs-audio sync
// math, container exercises the mux path — so the full 3x3 re-runs each axis
// three times over. The diagonal (30/mp4, 60/mkv, 120/mov) covers every fps AND
// every container once, which catches any single-factor regression; the other
// six cells only add joint coverage and ride the @matrix sweep.
const FPS = [30, 60, 120]
const CONTAINERS = ['mp4', 'mkv', 'mov']
const CASES = FPS.flatMap((fps, i) =>
  CONTAINERS.map((container, j) => ({ fps, container, diagonal: i === j })),
)
// Unequal axes would leave the extra levels without a diagonal cell — dropped
// from the per-PR tier with no failure to say so. Fail collection instead.
if (FPS.length !== CONTAINERS.length)
  throw new Error('the per-PR diagonal assumes FPS and CONTAINERS have equal length — retile which cells stay')

test.describe('audio conformance matrix (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  test.beforeAll(async () => {
    test.skip(
      !CASES.some((c) => existsSync(fixture(`test_1080p_${c.fps}fps_audio.mp4`))),
      'audio matrix fixtures not present (run `npm run fixtures`)',
    )
    ;({ app, page } = await launchApp())
  })
  test.afterAll(async () => {
    await app?.close()
  })

  for (const c of CASES) {
    const source = fixture(`test_1080p_${c.fps}fps_audio.mp4`)
    const tag = c.diagonal ? '' : ' @matrix'
    test(`${c.fps}fps source -> ${c.container} export stays aligned + synced + faithful${tag}`, async () => {
      test.skip(!existsSync(source), `audio source not found at ${source}`)
      test.setTimeout(240000)
      const output = path.join(
        tmpDir('weftcut-e2e-audio-out-'),
        `audio-${c.fps}-${c.container}.${c.container}`,
      )

      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-audio-proj-'),
        name: 'e2e-audio-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })

      const r = await driveExport(page, {
        mediaAbsPath: source,
        outputAbsPath: output,
        settings: { container: c.container },
      })
      if (!r.done.ok) {
        throw new Error(
          `exportClip failed: ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`,
        )
      }

      const report = analyze({ output, source, samples: [0], audio: true })
      console.log(`[e2e] audio report ${c.fps}fps/${c.container}:`, JSON.stringify(report))

      const misaligned = report.samples.filter((s: any) => !s.aligned)
      expect(
        misaligned,
        JSON.stringify(misaligned.map((s: any) => ({ second: s.second, detected: s.detected_freq }))),
      ).toHaveLength(0)
      expect(Math.abs(report.drift_slope - 1)).toBeLessThanOrEqual(0.01)
      expect(Math.abs(report.offset_ms)).toBeLessThanOrEqual(66)
      expect(report.pass).toBe(true)
    })
  }
})

// ─── 2. Audio-only format matrix ─────────────────────────────────────────────
// AUDIO-ONLY sources end-to-end, per format the import dialog offers: import
// (probe + classify as Audio) -> conform -> Audio layer -> audio-only export
// mix -> AAC `.m4a`, verified by `media_conformance --audio` against the
// per-second tone markers baked into the fixtures. The mp3 fixture carries
// attached_pic cover art — the real-world mp3 shape that detect_kind must
// classify as Audio, not Video (the regression guard).
// Every format runs the identical import -> conform -> Audio layer -> export
// pipeline; only the demuxer underneath differs. wav (uncompressed baseline) and
// mp3 (the attached_pic detect_kind guard described above) are the two that earn
// a per-PR slot — the rest ride the @matrix sweep.
const FORMATS = ['wav', 'mp3', 'flac', 'm4a', 'ogg']
const CORE_FORMATS = new Set(['wav', 'mp3'])

test.describe('audio-only format matrix (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  test.beforeAll(async () => {
    test.skip(
      !FORMATS.some((fmt) => existsSync(fixture(`test_tones_10s.${fmt}`))),
      'audio-only format fixtures not present (run `npm run fixtures`)',
    )
    ;({ app, page } = await launchApp())
  })
  test.afterAll(async () => {
    await app?.close()
  })

  for (const fmt of FORMATS) {
    const source = fixture(`test_tones_10s.${fmt}`)
    const tag = CORE_FORMATS.has(fmt) ? '' : ' @matrix'
    test(`${fmt} source -> audio export stays aligned + faithful${tag}`, async () => {
      test.skip(!existsSync(source), `audio source not found at ${source}`)
      test.setTimeout(220000)
      const output = path.join(tmpDir('weftcut-e2e-audiofmt-out-'), `${fmt}.m4a`)

      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-audiofmt-proj-'),
        name: `e2e-audiofmt-${fmt}-` + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })

      const r = await driveExport(
        page,
        {
          mediaAbsPath: source,
          outputAbsPath: output,
          settings: { includeVideo: false, includeAudio: true },
        },
        { timeout: 150000 },
      )
      if (!r.done.ok) {
        throw new Error(
          `exportClip failed: ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`,
        )
      }

      const report = analyze({ output, source, samples: [0], audio: true })
      console.log(`[e2e] audio-only report ${fmt}:`, JSON.stringify(report))

      const misaligned = report.samples.filter((s: any) => !s.aligned)
      expect(misaligned).toHaveLength(0)
      expect(Math.abs(report.drift_slope - 1)).toBeLessThanOrEqual(0.01)
      expect(Math.abs(report.offset_ms)).toBeLessThanOrEqual(66)
      expect(report.pass).toBe(true)
    })
  }
})

// ─── 3. Audio envelope conformance ───────────────────────────────────────────
// Audio-engine conformance (docs/audio.md): the deterministic Rust mixer
// upgrades audio assertions from perceptual (Goertzel tones) to ANALYTIC —
// windowed-RMS envelopes against closed-form expectations, the alimiter
// ceiling, and the equal-power pan law's L/R energy ratio.
test.describe('audio envelope conformance (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  test.beforeAll(async () => {
    test.skip(!existsSync(SOURCE), `tone source not found at ${SOURCE} (run \`npm run fixtures\`)`)
    ;({ app, page } = await launchApp())
  })
  test.afterAll(async () => {
    await app?.close()
  })

  /// Boot a fresh 30fps project and run exportClip with audio patches.
  async function bootAndExport(opts: {
    output: string
    audioPatches?: Array<Record<string, unknown>>
    settings?: Record<string, unknown>
  }) {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-audio-env-proj-'),
      name: 'e2e-audio-env-' + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    const args: Record<string, unknown> = { mediaAbsPath: SOURCE, outputAbsPath: opts.output }
    if (opts.audioPatches) args.audioPatches = opts.audioPatches
    args.settings = { includeVideo: false, includeAudio: true, ...(opts.settings ?? {}) }
    const r = await driveExport(page, args)
    if (!r.done.ok) {
      throw new Error(`exportClip failed: ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`)
    }
  }

  test('fade-in shapes the exported RMS envelope analytically', async () => {
    test.setTimeout(220000)
    // 1 s linear fade-in: window RMS deltas vs the loudest window are
    // 20·log10(t) — −12.04 dB at 0.25 s, −6.02 at 0.5 s, −2.50 at 0.75 s, 0 in
    // the body. ±1.5 dB bound absorbs AAC + the −1 dB limiter ceiling.
    const output = path.join(tmpDir('weftcut-e2e-audio-env-out-'), 'fadein.mp4')
    await bootAndExport({ output, audioPatches: [{ fade_in_us: 1_000_000 }] })

    const report = analyzeAudioEnvelope({
      output,
      expects: [
        { t_s: 0.25, expect_rms_db_delta: -12.04 },
        { t_s: 0.5, expect_rms_db_delta: -6.02 },
        { t_s: 0.75, expect_rms_db_delta: -2.5 },
        { t_s: 5.0, expect_rms_db_delta: 0.0 },
      ],
    })
    console.log('[e2e] fade-in envelope report:', JSON.stringify(report))
    expect(report.pass).toBe(true)
  })

  test('fade-out shapes the tail and static gain offsets the body', async () => {
    test.setTimeout(220000)
    // −6 dB static gain + 1 s fade-out on a 10 s clip: the loudest window is the
    // body (uniform gain is delta-independent); the tail ramps down −6.02 dB at
    // 9.5 s, −12.04 dB at 9.75 s.
    const output = path.join(tmpDir('weftcut-e2e-audio-env-out-'), 'fadeout.mp4')
    await bootAndExport({ output, audioPatches: [{ gain_db: -6, fade_out_us: 1_000_000 }] })

    const report = analyzeAudioEnvelope({
      output,
      expects: [
        { t_s: 5.0, expect_rms_db_delta: 0.0 },
        { t_s: 9.5, expect_rms_db_delta: -6.02 },
        { t_s: 9.75, expect_rms_db_delta: -12.04 },
      ],
    })
    console.log('[e2e] fade-out envelope report:', JSON.stringify(report))
    expect(report.pass).toBe(true)
  })

  test('two overlapping layers sum and the limiter holds the -1 dB ceiling', async () => {
    test.setTimeout(220000)
    // The same clip stacked twice (0 dB + −6 dB). The summed peak must never
    // exceed the alimiter ceiling (−1 dB ≈ −0.9 dBFS with codec slop).
    const output = path.join(tmpDir('weftcut-e2e-audio-env-out-'), 'overlap.mp4')
    await bootAndExport({ output, audioPatches: [{}, { gain_db: -6 }] })

    const report = analyzeAudioEnvelope({
      output,
      expects: [{ t_s: 5.0, expect_rms_db_delta: 0.0 }],
      peakMaxDb: -0.9,
    })
    console.log('[e2e] overlap+limiter report:', JSON.stringify(report))
    expect(report.peak_ceiling_pass).toBe(true)
    expect(report.pass).toBe(true)
  })

  test('pan -0.8 lands the equal-power L/R energy ratio', async () => {
    test.setTimeout(220000)
    // Equal-power law for pan = −0.8: L−R = 20·log10(cot(0.05π)) ≈ +16.0 dB.
    const output = path.join(tmpDir('weftcut-e2e-audio-env-out-'), 'pan.mp4')
    await bootAndExport({ output, audioPatches: [{ pan: -0.8 }] })

    const report = analyzeAudioPan({ output, expectLrDb: 16.0 })
    console.log('[e2e] pan report:', JSON.stringify(report))
    expect(report.pass).toBe(true)
  })
})

// ─── 4. Role-based mixing conformance ────────────────────────────────────────
// Proves the audio-roles feature end-to-end: audio mixes by per-layer ROLE
// (Dialogue/Music/SFX/Voiceover), and ROLE mute/solo + role gain gate the mix —
// track mute/solo no longer do (docs/audio.md, ADR 0023). Two copies of the
// single-tone source carry identical correlated content, so we separate them in
// the STEREO FIELD and read the per-channel RMS ratio with `--audio-pan`: tag
// one copy `dialogue` panned left and the other `music` panned right.
//
// Role flags/gain are driven by the real IPC the Mixer panel uses
// (`update_role_flags` / `set_role_gain`); per-layer role + pan via
// `update_layer_params`. Setup is composed manually (import + place same source
// twice, then export the timeline) because the role-flag mutation must land
// BETWEEN patching the layers and running the export.
const ROLE_PAN = 0.6
// L−R for the lone left-panned (−0.6) dialogue layer after music is silenced.
const DIALOGUE_ONLY_LR_DB =
  20 *
  Math.log10(
    Math.cos(((-ROLE_PAN + 1) * Math.PI) / 4) / Math.sin(((-ROLE_PAN + 1) * Math.PI) / 4),
  )

test.describe('audio role mixing conformance (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  test.beforeAll(async () => {
    test.skip(!existsSync(SOURCE), `tone source not found at ${SOURCE} (run \`npm run fixtures\`)`)
    ;({ app, page } = await launchApp())
  })
  test.afterAll(async () => {
    await app?.close()
  })

  /// The auto-paired Audio layer ids, in placement order, from the live summary.
  /// Throws if fewer than `min` exist (auto-pair off, or no audio stream).
  async function audioLayerIds(min = 1): Promise<string[]> {
    const sum = await summary(page)
    const ids: string[] = []
    for (const tr of sum.tracks) {
      for (const l of tr.layers) {
        if (l.params.kind === 'Audio') ids.push(l.id)
      }
    }
    if (ids.length < min) {
      throw new Error(
        `expected >=${min} auto-paired Audio layer(s), found ${ids.length} — is ` +
          `auto_pair_audio_on_import off, or does the fixture lack an audio stream?`,
      )
    }
    return ids
  }

  test('muting the music role drops the music layer while dialogue remains', async () => {
    test.setTimeout(300000)
    const output = path.join(tmpDir('weftcut-e2e-role-out-'), 'role-mute.mp4')

    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-audio-roles-proj-'),
      name: 'e2e-audio-roles-' + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })

    // Import once, place the SAME media twice (one mediaId, two layers) so the
    // two audio copies are byte-identical content separated only by role + pan.
    const first = await importAndPlaceMedia(page, { mediaAbsPath: SOURCE, tStartUs: 0 })
    await placeMediaLayer(page, { mediaId: first.mediaId, tStartUs: 0 })

    // Tag the two auto-paired Audio layers: dialogue hard-ish left, music
    // hard-ish right (∓0.6 keeps both channels finite under either mix).
    const [dialogueLayer, musicLayer] = await audioLayerIds(2)
    await invokeCmd(page, 'update_layer_params', {
      layerId: dialogueLayer,
      patch: { kind: 'Audio', role: 'dialogue', pan: -ROLE_PAN },
    })
    await invokeCmd(page, 'update_layer_params', {
      layerId: musicLayer,
      patch: { kind: 'Audio', role: 'music', pan: ROLE_PAN },
    })

    // Sanity: both roles audible ⇒ symmetric stereo field (L−R ≈ 0 dB).
    const baselineOut = path.join(tmpDir('weftcut-e2e-role-out-'), 'role-baseline.mp4')
    const AUDIO_ONLY = { includeVideo: false, includeAudio: true }
    let r = await driveExport(page, { outputAbsPath: baselineOut, settings: AUDIO_ONLY }, { hook: 'exportTimeline' })
    if (!r.done.ok) throw new Error(`baseline export failed: ${r.done.error}`)
    const baseline = analyzeAudioPan({ output: baselineOut, expectLrDb: 0.0 })
    console.log('[e2e] role baseline pan report:', JSON.stringify(baseline))
    expect(baseline.pass).toBe(true)

    // Mute the MUSIC role — the only lever that silences the music.
    await invokeCmd(page, 'update_role_flags', { role: 'music', patch: { muted: true } })

    r = await driveExport(page, { outputAbsPath: output, settings: AUDIO_ONLY }, { hook: 'exportTimeline' })
    if (!r.done.ok) {
      throw new Error(`role-mute export failed: ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`)
    }

    // The right channel collapses to dialogue's small right-bleed: L−R jumps to
    // the lone-left-panned-dialogue value, proving the music layer is gone.
    const muted = analyzeAudioPan({ output, expectLrDb: DIALOGUE_ONLY_LR_DB })
    console.log(
      `[e2e] role-mute pan report (expect L−R≈${DIALOGUE_ONLY_LR_DB.toFixed(2)} dB):`,
      JSON.stringify(muted),
    )
    expect(muted.pass).toBe(true)
    // And it really moved off the symmetric baseline (a no-op mute leaves ≈0).
    expect(muted.lr_delta_db).toBeGreaterThan(baseline.lr_delta_db + 3)

    // Dialogue's own per-second tone content survived the mix.
    const tones = analyze({ output, source: SOURCE, samples: [0], audio: true })
    console.log('[e2e] role-mute tone report:', JSON.stringify(tones))
    expect(tones.samples.filter((s: any) => !s.aligned)).toHaveLength(0)
    expect(tones.pass).toBe(true)
  })

  test('role gain trims the role level by the analytic dB factor', async () => {
    test.setTimeout(300000)
    // A single dialogue layer (centered), exported at role gain 0 dB then
    // −12 dB. Role gain folds uniformly into the layer's gain envelope, so the
    // file's absolute sample peak scales by the same factor: −12 dB ⇒ ×0.251.
    const ROLE_GAIN_DB = -12
    const outDir = tmpDir('weftcut-e2e-role-gain-out-')
    const out0 = path.join(outDir, 'role-gain-0.mp4')
    const outDown = path.join(outDir, 'role-gain-down.mp4')
    // A trivial always-true expectation just to populate a report; we read
    // peak_dbfs (the loudest window vs itself is 0 dB by construction).
    const expects = [{ t_s: 5.0, expect_rms_db_delta: 0.0 }]

    /// Boot a fresh single-dialogue-layer project, set the role gain, export,
    /// and return the file's absolute peak dBFS.
    const exportAtRoleGain = async (output: string, gainDb: number): Promise<number> => {
      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-audio-roles-proj-'),
        name: 'e2e-audio-rolegain-' + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      await importAndPlaceMedia(page, { mediaAbsPath: SOURCE, tStartUs: 0 })

      const [layer] = await audioLayerIds()
      await invokeCmd(page, 'update_layer_params', {
        layerId: layer,
        patch: { kind: 'Audio', role: 'dialogue', pan: 0 },
      })
      await invokeCmd(page, 'set_role_gain', { role: 'dialogue', gainDb })

      const r = await driveExport(
        page,
        { outputAbsPath: output, settings: { includeVideo: false, includeAudio: true } },
        { hook: 'exportTimeline' },
      )
      if (!r.done.ok) {
        throw new Error(
          `role-gain export failed (gain ${gainDb} dB): ${r.done.error} | kind=${r.lastKind} detail=${r.lastDetail}`,
        )
      }
      const report = analyzeAudioEnvelope({ output, expects })
      console.log(`[e2e] role-gain ${gainDb} dB envelope report:`, JSON.stringify(report))
      return report.peak_dbfs
    }

    const peakUnity = await exportAtRoleGain(out0, 0)
    const peakDown = await exportAtRoleGain(outDown, ROLE_GAIN_DB)

    // The peak fell by ~|ROLE_GAIN_DB|, proving role gain reached the export mix.
    const drop = peakUnity - peakDown
    console.log(`[e2e] role-gain peak drop: ${drop.toFixed(2)} dB (expect ≈ ${-ROLE_GAIN_DB} dB)`)
    expect(Math.abs(drop - -ROLE_GAIN_DB)).toBeLessThanOrEqual(1.5)
  })
})
