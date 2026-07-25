import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  importAndPlaceMedia,
  invokeCmd,
  launchApp,
  newProject,
  summary,
  tmpDir,
  type ProjectSummary,
} from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const fixture = (name: string) => path.resolve(MEDIA_DIR, name)

const CASES = [
  { name: 'zero PTS', file: 'test_audio_timing_zero_pts.mkv', startPtsUs: 0 },
  { name: '375 ms first PTS', file: 'test_audio_timing_offset_375ms.mkv', startPtsUs: 375_000 },
]
const SOUND_TIMES_S = [1.125, 3.125, 5.125]
const SILENT_TIMES_S = [0.5, 2.0, 4.0, 5.75]
const LONG_FIXTURE = 'test_audio_timing_long_125s.mkv'
const LONG_SOUND_TIMES_S = [5.25, 60.25, 120.25]
const LONG_SOUND_RANGES_S = [
  { start: 5, end: 5.5 },
  { start: 60, end: 60.5 },
  { start: 120, end: 120.5 },
] as const
const LONG_SILENT_TIMES_S = [2.0, 30.0, 90.0, 124.0]
const LONG_LODS = [
  { pxPerSec: 80, minPps: 62, maxPps: 63 },
  { pxPerSec: 15, minPps: 15, maxPps: 16 },
  { pxPerSec: 8, minPps: 7, maxPps: 8 },
] as const

type AlignmentSummary = ProjectSummary & {
  media: Array<{
    id: string
    start_pts_us: number | null
    video_start_pts_us: number | null
    audio_start_pts_us: number | null
    conform_path: string | null
  }>
}

async function waitForConformPath(page: Page, mediaId: string): Promise<string> {
  let conformPath: string | null = null
  await expect
    .poll(
      async () => {
        const s = (await summary(page)) as AlignmentSummary
        conformPath = s.media.find((m) => m.id === mediaId)?.conform_path ?? null
        return conformPath
      },
      { timeout: 60_000, intervals: [100, 250, 500, 1000] },
    )
    .not.toBeNull()
  return conformPath!
}

// Read the exact PCM artifact used by AudioMixer. Keeping this in the e2e
// process avoids testing a second decoder: waveform and preview are compared
// after their independent background jobs have both completed.
function conformRmsAt(file: string, timeS: number, windowMs = 80): number {
  const fd = openSync(file, 'r')
  try {
    const header = Buffer.alloc(28)
    expect(readSync(fd, header, 0, header.length, 0)).toBe(header.length)
    expect(header.subarray(0, 8).toString('binary')).toBe('VCONF\0\0\0')
    const sampleRate = header.readUInt32LE(12)
    const channels = header.readUInt32LE(16)
    const frameCount = Number(header.readBigUInt64LE(20))
    const frames = Math.round((windowMs / 1000) * sampleRate)
    const center = Math.round(timeS * sampleRate)
    const start = Math.max(0, Math.min(frameCount - frames, center - Math.floor(frames / 2)))
    const bytes = Buffer.alloc(frames * channels * 4)
    expect(readSync(fd, bytes, 0, bytes.length, 28 + start * channels * 4)).toBe(bytes.length)
    let sumSq = 0
    const samples = frames * channels
    for (let i = 0; i < samples; i++) {
      const v = bytes.readFloatLE(i * 4)
      sumSq += v * v
    }
    return Math.sqrt(sumSq / samples)
  } finally {
    closeSync(fd)
  }
}

test.describe('timeline waveform ↔ preview PCM alignment (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  test.beforeAll(async () => {
    test.skip(
      !CASES.every((c) => existsSync(fixture(c.file))) || !existsSync(fixture(LONG_FIXTURE)),
      'audio timing fixtures not present (run `npm run fixtures`)',
    )
    ;({ app, page } = await launchApp())
  })

  test.afterAll(async () => {
    await app?.close()
  })

  for (const c of CASES) {
    test(`${c.name}: known sound times agree after both background jobs load`, async () => {
      test.setTimeout(120_000)
      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-waveform-align-proj-'),
        name: `e2e-waveform-align-${c.startPtsUs}-${Date.now()}`,
        canvas: { width: 320, height: 180, fpsNum: 30, fpsDen: 1 },
      })
      const { mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: fixture(c.file) })

      // First-PTS is asserted independently, so a fixture accidentally remuxed
      // back to zero cannot make the offset case pass vacuously.
      const imported = ((await summary(page)) as AlignmentSummary).media.find((m) => m.id === mediaId)!
      expect(imported.start_pts_us).toBe(c.startPtsUs)
      expect(imported.video_start_pts_us).toBe(c.startPtsUs)
      expect(imported.audio_start_pts_us).toBe(c.startPtsUs)

      const allTimesS = [...SOUND_TIMES_S, ...SILENT_TIMES_S]
      const [waveform, conformPath] = await Promise.all([
        page.evaluate(
          ({ id, timesUs }) => (window as any).__weftcutTest.sampleWaveformRms({ mediaId: id, timesUs }),
          { id: mediaId, timesUs: allTimesS.map((t) => t * 1_000_000) },
        ) as Promise<{ peaksPerSecond: number; rms: number[] }>,
        waitForConformPath(page, mediaId),
      ])

      for (const [index, timeS] of SOUND_TIMES_S.entries()) {
        const conformRms = conformRmsAt(conformPath, timeS)
        expect(conformRms, `preview PCM should contain sound at ${timeS}s`).toBeGreaterThan(0.05)
        expect(waveform.rms[index], `waveform should show sound at ${timeS}s`).toBeGreaterThan(0.05)
      }
      for (const [index, timeS] of SILENT_TIMES_S.entries()) {
        const conformRms = conformRmsAt(conformPath, timeS)
        expect(conformRms, `preview PCM should be silent at ${timeS}s`).toBeLessThan(0.005)
        expect(
          waveform.rms[SOUND_TIMES_S.length + index],
          `waveform should be flat at ${timeS}s`,
        ).toBeLessThan(0.005)
      }
    })
  }

  // A sub-frame slip must not desynchronize the WAVEFORM from the PCM (ADR 0038).
  // Extends this gate rather than adding a parallel one, per ticket 11: the waveform
  // is addressed in MEDIA time (`sampleWaveformRms` takes source µs), so slipping the
  // layer on the timeline must leave the waveform↔PCM relationship untouched — if the
  // slip had leaked into media addressing, these markers would move.
  test('a sub-frame timeline slip leaves waveform ↔ PCM addressing untouched', async () => {
    test.setTimeout(120_000)
    const c = CASES[0]!
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-waveform-slip-proj-'),
      name: `e2e-waveform-slip-${Date.now()}`,
      // 30 fps: a frame is 1600 samples, so 800 samples IS half a frame — a slip that
      // simply cannot be expressed on the composition grid.
      canvas: { width: 320, height: 180, fpsNum: 30, fpsDen: 1 },
    })
    const { mediaId, layerId } = await importAndPlaceMedia(page, { mediaAbsPath: fixture(c.file) })
    const conformPath = await waitForConformPath(page, mediaId)

    const trackOf = async (id: string): Promise<string> => {
      const s = (await summary(page)) as unknown as {
        tracks: Array<{ id: string; layers: Array<{ id: string }> }>
      }
      return s.tracks.find((t) => t.layers.some((l) => l.id === id))!.id
    }
    const startOf = async (id: string): Promise<number> => {
      const s = (await summary(page)) as unknown as {
        tracks: Array<{ layers: Array<{ id: string; t_start_us: number }> }>
      }
      return s.tracks.flatMap((t) => t.layers).find((l) => l.id === id)!.t_start_us
    }
    // The AV source auto-pairs, so the Audio member is the one to slip.
    const audioLayer = ((await summary(page)) as unknown as {
      tracks: Array<{ layers: Array<{ id: string; params: { kind: string } }> }>
    }).tracks
      .flatMap((t) => t.layers)
      .find((l) => l.params.kind === 'Audio')?.id
    expect(audioLayer, 'the AV source should have auto-paired an Audio layer').toBeTruthy()

    // 16_667 µs is sample 800 — exactly half a 30 fps frame, so it is only reachable
    // because audio no longer shares the video grid. Production `command` channel, so
    // the wire args are camelCase.
    const SLIP_US = 16_667
    await invokeCmd(page, 'move_layer', {
      layerId: audioLayer,
      newTrackId: await trackOf(audioLayer!),
      newTStartUs: SLIP_US,
      escapeGroup: true,
    })
    expect(await startOf(audioLayer!), 'the slip must be stored verbatim').toBe(SLIP_US)
    expect(await startOf(layerId), 'the video member must not move').toBe(0)

    // The waveform is keyed on MEDIA time, so every known marker must read exactly as
    // it did before the timeline edit — and still agree with the conform PCM.
    const allTimesS = [...SOUND_TIMES_S, ...SILENT_TIMES_S]
    const waveform = (await page.evaluate(
      ({ id, timesUs }) => (window as any).__weftcutTest.sampleWaveformRms({ mediaId: id, timesUs }),
      { id: mediaId, timesUs: allTimesS.map((t) => t * 1_000_000) },
    )) as { peaksPerSecond: number; rms: number[] }

    for (const [index, timeS] of SOUND_TIMES_S.entries()) {
      expect(conformRmsAt(conformPath, timeS), `preview PCM sound at ${timeS}s`).toBeGreaterThan(0.05)
      expect(waveform.rms[index], `waveform sound at ${timeS}s after a slip`).toBeGreaterThan(0.05)
    }
    for (const [index, timeS] of SILENT_TIMES_S.entries()) {
      expect(conformRmsAt(conformPath, timeS), `preview PCM silence at ${timeS}s`).toBeLessThan(0.005)
      expect(
        waveform.rms[SOUND_TIMES_S.length + index],
        `waveform flat at ${timeS}s after a slip`,
      ).toBeLessThan(0.005)
    }
  })

  test('125 s sparse markers stay aligned across coarse waveform LODs', async () => {
    test.setTimeout(180_000)
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-waveform-align-proj-'),
      name: `e2e-waveform-align-long-${Date.now()}`,
      canvas: { width: 320, height: 180, fpsNum: 30, fpsDen: 1 },
    })
    const { mediaId } = await importAndPlaceMedia(page, {
      mediaAbsPath: fixture(LONG_FIXTURE),
    })
    const conformPath = await waitForConformPath(page, mediaId)
    const allTimesS = [...LONG_SOUND_TIMES_S, ...LONG_SILENT_TIMES_S]

    // Establish marker truth from the exact conform artifact consumed by the
    // preview mixer. This also guards against accidental fixture changes.
    for (const timeS of LONG_SOUND_TIMES_S) {
      expect(conformRmsAt(conformPath, timeS), `preview PCM sound at ${timeS}s`).toBeGreaterThan(0.05)
    }
    for (const timeS of LONG_SILENT_TIMES_S) {
      expect(conformRmsAt(conformPath, timeS), `preview PCM silence at ${timeS}s`).toBeLessThan(0.005)
    }

    for (const lod of LONG_LODS) {
      const waveform = (await page.evaluate(
        ({ id, timesUs, pxPerSec }) =>
          (window as any).__weftcutTest.sampleWaveformRms({ mediaId: id, timesUs, pxPerSec }),
        {
          id: mediaId,
          timesUs: allTimesS.map((t) => t * 1_000_000),
          pxPerSec: lod.pxPerSec,
        },
      )) as { peaksPerSecond: number; rms: number[] }

      // Prove each request actually selected the intended real producer LOD.
      expect(waveform.peaksPerSecond).toBeGreaterThan(lod.minPps)
      expect(waveform.peaksPerSecond).toBeLessThan(lod.maxPps)
      for (const [index, timeS] of LONG_SOUND_TIMES_S.entries()) {
        expect(
          waveform.rms[index],
          `${lod.pxPerSec}px/s waveform should show the PCM marker at ${timeS}s`,
        ).toBeGreaterThan(0.05)
      }
      for (const [index, timeS] of LONG_SILENT_TIMES_S.entries()) {
        expect(
          waveform.rms[LONG_SOUND_TIMES_S.length + index],
          `${lod.pxPerSec}px/s waveform should be flat at ${timeS}s`,
        ).toBeLessThan(0.005)
      }

      // Locate each island's first/last active peak directly. At a valid exact
      // timebase, quantizing a PCM boundary can move it by at most one peak;
      // the former integer-density metadata misses this window increasingly
      // badly toward 120 s (especially at the 15/8 px/s LODs).
      for (const range of LONG_SOUND_RANGES_S) {
        const expectedFirst = Math.floor(range.start * waveform.peaksPerSecond)
        const expectedLast = Math.ceil(range.end * waveform.peaksPerSecond) - 1
        const candidatePeaks: number[] = []
        for (let peak = expectedFirst - 2; peak <= expectedLast + 2; peak++) {
          candidatePeaks.push(peak)
        }
        const boundary = (await page.evaluate(
          ({ id, timesUs, pxPerSec }) =>
            (window as any).__weftcutTest.sampleWaveformRms({
              mediaId: id,
              timesUs,
              pxPerSec,
              windowMs: 0,
            }),
          {
            id: mediaId,
            // +0.1 keeps Math.round in the requested peak's index cell.
            timesUs: candidatePeaks.map(
              (peak) => ((peak + 0.1) / waveform.peaksPerSecond) * 1_000_000,
            ),
            pxPerSec: lod.pxPerSec,
          },
        )) as { peaksPerSecond: number; rms: number[] }
        const active = candidatePeaks.filter((_, index) => boundary.rms[index]! > 0.01)
        expect(
          active.length,
          `${lod.pxPerSec}px/s active peaks near ${range.start}s`,
        ).toBeGreaterThan(0)
        expect(Math.abs(active[0]! - expectedFirst)).toBeLessThanOrEqual(1)
        expect(Math.abs(active.at(-1)! - expectedLast)).toBeLessThanOrEqual(1)
      }
    }
  })
})
