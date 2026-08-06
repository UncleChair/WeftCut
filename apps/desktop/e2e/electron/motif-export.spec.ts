// e2e gate: motif export — countdown baked and present in the output file.
//
// Assertion: two output frames in DIFFERENT seconds differ (self-SSIM well
// below 1.0). The countdown's numeral changes at 1-second boundaries AND its
// progress arc sweeps every frame; a skipped/static motif scores ~1.0 (identical
// black frames) while an animating motif scores far lower. We use frame 10
// (≈0.33 s, numeral 2) vs frame 50 (≈1.67 s, numeral 1).

import { test, expect } from '@playwright/test'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeSelf } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport, tmpDir } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('motif export: countdown animates in output (frames differ across seconds)', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'WebCodecs H.264 encode needs a GPU not available on headless CI runners; motif export is verified locally',
  )
  test.setTimeout(300_000)
  const OUTPUT = path.join(tmpDir('weftcut-e2e-motif-out-'), 'motif-out.mp4')
  const PROJECT_PARENT = tmpDir('weftcut-e2e-motif-proj-')
  rmSync(OUTPUT, { force: true })

  const { app, page } = await launchApp()
  try {
    // 480×480 project matches countdown native size: the motif fills the frame
    // so the self-SSIM threshold has a wide margin.
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-exp-' + Date.now(),
      canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
    })

    // exportMotifClip: add a 2 s countdown at t=0, bake, composite, encode.
    // Phase: preparing (bake) → progress (encode) → complete.
    const r = await driveExport(
      page,
      {
        motifId: 'countdown',
        outputAbsPath: OUTPUT,
        durationUs: 2_000_000,
      },
      { hook: 'exportMotifClip', timeout: 280_000 },
    )
    if (!r.done.ok) throw new Error('exportMotifClip failed: ' + r.done.error)

    expect(existsSync(OUTPUT), 'output file must exist after export').toBe(true)

    const report = analyzeSelf({ output: OUTPUT, samples: [10, 50], ssimMax: 0.99 })
    console.log('[export] motif self-ssim report:', JSON.stringify(report))

    const pair = report.pairs[0]
    if (!pair) throw new Error('no self-ssim pair returned: ' + JSON.stringify(report))
    if (!pair.differ) {
      throw new Error(
        `motif frames did NOT differ (ssim ${pair.ssim.toFixed(4)} >= 0.99) — ` +
          `the motif likely rendered static/black (skipped) in export`,
      )
    }
    expect(report.pass).toBe(true)
  } finally {
    await app.close()
  }
})
