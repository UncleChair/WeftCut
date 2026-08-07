import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport, tmpDir, exportSsimFloor } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps_6s.mp4')

test('H.264 import -> export stays frame-aligned with low loss (Electron)', async ({}, testInfo) => {
  test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
  test.setTimeout(220000)
  const PROJECT_PARENT = tmpDir('weftcut-e2e-proj-')
  const OUTPUT = path.join(tmpDir('weftcut-e2e-out-'), 'out.mp4')

  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-' + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    const r = await driveExport(page, { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT })
    if (!r.done.ok) throw new Error('exportClip failed: ' + r.done.error)

    // Frame alignment (strict) + app-only loss (loose 0.80 floor) at interior
    // frames — one sample per 2s GOP of the 6s fixture, the last 30 frames
    // before EOS (the analyzer's ±2 match window needs center+2 <= 179).
    const SSIM_FLOOR = exportSsimFloor()
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 90, 150], ssimMin: SSIM_FLOOR })
    const misaligned = report.samples.filter((s: any) => !s.aligned)
    const lowSsim = report.samples.filter((s: any) => s.ssim < SSIM_FLOOR)
    if (misaligned.length || lowSsim.length || !report.pass) {
      // Ship the actual pixels with the failure — a CI SSIM number alone can't
      // distinguish blur, color shift, or misrender.
      await testInfo.attach('export-output.mp4', { path: OUTPUT, contentType: 'video/mp4' })
      await testInfo.attach('source-fixture.mp4', { path: SOURCE, contentType: 'video/mp4' })
    }
    expect(misaligned, JSON.stringify(misaligned)).toHaveLength(0)
    expect(lowSsim, JSON.stringify(lowSsim)).toHaveLength(0)
    expect(report.pass).toBe(true)
  } finally {
    await app.close()
  }
})
