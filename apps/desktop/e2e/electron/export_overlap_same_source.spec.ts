import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, waitForHook, driveExport } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps.mp4')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-overlap-proj')
const OUT_BASELINE = path.resolve(os.tmpdir(), 'weftcut-e2e-overlap-baseline.mp4')
const OUT_STACKED = path.resolve(os.tmpdir(), 'weftcut-e2e-overlap-stacked.mp4')
const OUT_OFFSET = path.resolve(os.tmpdir(), 'weftcut-e2e-overlap-offset.mp4')
const SSIM_FLOOR = 0.8
const OFFSET_US = 2_000_000
const OFFSET_FRAMES = 60

async function bootProject(page: Page, prefix: string): Promise<void> {
  await newProject(page, {
    parentFolder: PROJECT_PARENT,
    name: prefix + Date.now(),
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
  })
  await waitForHook(page, 'exportTimeline')
}

// Import SOURCE once at t=0, then place `extras` more copies of the SAME
// mediaId (one fresh track each), and wait for export readiness.
async function placeSameSourceClips(page: Page, extras: number[]): Promise<void> {
  const r = (await page.evaluate(
    async ({ media, exs }) => {
      try {
        const first = await (window as any).__weftcutTest.importAndPlaceMedia({ mediaAbsPath: media, tStartUs: 0 })
        for (const tStartUs of exs) {
          await (window as any).__weftcutTest.placeMediaLayer({ mediaId: first.mediaId, tStartUs })
        }
        await (window as any).__weftcutTest.waitMediaExportReady({ mediaId: first.mediaId })
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
    { media: SOURCE, exs: extras },
  )) as { ok: boolean; error?: string }
  if (!r.ok) throw new Error('placing clips failed: ' + r.error)
}

async function runTimelineExport(page: Page, output: string): Promise<{ totalFrames: number; totalDispatched: number }> {
  rmSync(output, { force: true })
  const r = await driveExport(page, { outputAbsPath: output }, { hook: 'exportTimeline' })
  if (!r.done.ok) throw new Error('exportTimeline failed: ' + r.done.error)
  const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
    | { totalFrames: number; totalDispatched: number }
    | null
  if (!perf) throw new Error('export settled but __weftcutExportPerf is missing')
  return perf
}

function assertIdentityAligned(report: any): void {
  const misaligned = report.samples.filter((s: any) => !s.aligned)
  expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
  const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
  expect(lowSsim, JSON.stringify(lowSsim)).toHaveLength(0)
}

test.describe('same-source overlapping clips export (Electron)', () => {
  let baselineDispatched: number | null = null
  test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)

  test.beforeAll(() => {
    mkdirSync(PROJECT_PARENT, { recursive: true })
  })

  test('baseline: a single clip exports clean (dispatch reference)', async () => {
    test.setTimeout(220000)
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-overlap-base-')
      await placeSameSourceClips(page, [])
      const perf = await runTimelineExport(page, OUT_BASELINE)
      expect(perf.totalFrames, '10s @ 30fps = 300 frames').toBe(300)
      baselineDispatched = perf.totalDispatched
      const report = analyze({ output: OUT_BASELINE, source: SOURCE, samples: [30, 150, 290], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(report)
    } finally {
      await app.close()
    }
  })

  test('two stacked enabled clips export without wedging or extra decode', async () => {
    test.setTimeout(220000)
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-overlap-stack-')
      await placeSameSourceClips(page, [0])
      const perf = await runTimelineExport(page, OUT_STACKED)
      expect(perf.totalFrames).toBe(300)
      const report = analyze({ output: OUT_STACKED, source: SOURCE, samples: [30, 150, 290], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(report)
      if (baselineDispatched == null) throw new Error('baseline dispatch reference missing')
      const ceiling = Math.ceil(baselineDispatched * 1.25)
      expect(perf.totalDispatched, `stacked must merge same-source ranges (<= ${ceiling})`).toBeLessThanOrEqual(ceiling)
    } finally {
      await app.close()
    }
  })

  test('a 2s-offset overlap exports complete with both clips on their own frames', async () => {
    test.setTimeout(360000)
    const { app, page } = await launchApp()
    try {
      await bootProject(page, 'e2e-overlap-offset-')
      await placeSameSourceClips(page, [OFFSET_US])
      const perf = await runTimelineExport(page, OUT_OFFSET)
      expect(perf.totalFrames, '12s composition = 360 frames').toBe(360)
      const headReport = analyze({ output: OUT_OFFSET, source: SOURCE, samples: [30], ssimMin: SSIM_FLOOR })
      assertIdentityAligned(headReport)
      const tail = analyze({ output: OUT_OFFSET, source: SOURCE, samples: [200], window: OFFSET_FRAMES + 2 })
      const s = tail.samples[0]
      expect(s.best_match_index, `output 200 best-matches source ${200 - OFFSET_FRAMES}`).toBe(200 - OFFSET_FRAMES)
    } finally {
      await app.close()
    }
  })
})
