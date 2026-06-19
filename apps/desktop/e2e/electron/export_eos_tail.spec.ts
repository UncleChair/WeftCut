import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps_eostail.mp4')
const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-eostail-out.mp4')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-eostail-proj')

// Final GOP spans chunks + 11s audio overhang vs 10s video — the EOS-tail
// deadlock class. The export must COMPLETE (the deadlock pinned the counter),
// plan 330 frames, and keep the drained tail frame-aligned.
test('EOS-tail export completes and keeps the drained tail frame-aligned (Electron)', async () => {
  test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
  test.setTimeout(220000)
  mkdirSync(PROJECT_PARENT, { recursive: true })
  rmSync(OUTPUT, { force: true })

  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-eostail-' + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    const r = await driveExport(page, { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT })
    if (!r.done.ok) throw new Error('exportClip failed: ' + r.done.error)

    const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
      | { totalFrames: number; totalDispatched: number }
      | null
    expect(perf, '__weftcutExportPerf must be set after export (E2E build)').not.toBeNull()
    expect(perf!.totalFrames, 'audio-extended 11s composition plans 330 frames').toBe(330)

    // Samples 200 + 270 sit inside the EOS drain region; keep below 300 (the
    // clamp-held overhang frames are last-frame dups by design).
    const SSIM_FLOOR = 0.8
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150, 200, 270], ssimMin: SSIM_FLOOR })
    const misaligned = report.samples.filter((s: any) => !s.aligned)
    expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
    expect(lowSsim, JSON.stringify(lowSsim)).toHaveLength(0)
    expect(report.pass).toBe(true)
  } finally {
    await app.close()
  }
})
