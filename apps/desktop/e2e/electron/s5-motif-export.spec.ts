// S5 e2e gate: motif export — countdown baked and present in the output file.
//
// Mirrors `e2e/specs/motif/export.e2e.js`.
//
// Assertion: two output frames in DIFFERENT seconds differ (self-SSIM well
// below 1.0). The countdown's numeral changes at 1-second boundaries AND its
// progress arc sweeps every frame; a skipped/static motif scores ~1.0 (identical
// black frames) while an animating motif scores far lower. We use frame 10
// (≈0.33 s, numeral 2) vs frame 50 (≈1.67 s, numeral 1).
//
// driveExport(hook:"exportMotifClip") fires the hook, polls __e2eExportDone,
// and returns the settled state — same polling loop as the wdio helper.

import { test, expect } from '@playwright/test'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// analyzeSelf runs `cargo run --bin media_conformance -- --self-ssim ...`
// and returns { pass, pairs: [{ a, b, ssim, differ }] }.
import { analyzeSelf } from '../lib/analyze.mjs'
import { launchApp, newProject, driveExport } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const OUTPUT = path.resolve(os.tmpdir(), 'weftcut-e2e-s5-motif-out.mp4')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-s5-motif-proj')

test('S5 motif export: countdown animates in output (frames differ across seconds)', async () => {
  test.setTimeout(300_000)
  mkdirSync(PROJECT_PARENT, { recursive: true })
  rmSync(OUTPUT, { force: true })

  const { app, page } = await launchApp()
  try {
    // 480×480 project matches countdown native size: the motif fills the frame
    // so the self-SSIM threshold has a wide margin.
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-s5-exp-' + Date.now(),
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

    // Self-SSIM: frame 10 ≈ 0.33 s (numeral 2) vs frame 50 ≈ 1.67 s (numeral 1).
    // A static/skipped motif would score ~1.0; the animated countdown scores far lower.
    const report = analyzeSelf({ output: OUTPUT, samples: [10, 50], ssimMax: 0.99 })
    console.log('[s5-export] motif self-ssim report:', JSON.stringify(report))

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
