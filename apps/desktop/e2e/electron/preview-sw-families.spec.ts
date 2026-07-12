import { test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, waitForHook } from './helpers/driver'

// Phase-2 Plan A conformance for the non-ProRes blind-spot families that CAN be
// synthesized: DNxHR (intra) and MPEG-2 (long-GOP). ProRes stays proven in
// preview-sw-conformance.spec.ts. VC-1/WMV3 have no ffmpeg encoder → covered by
// the Rust routing test + codec-agnostic decoder, not here. Reuses the
// decode-bench fixtures (e2e/scripts/gen-decode-bench-fixtures.mjs).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BENCH_DIR = path.resolve(__dirname, '../fixtures/decode-bench')
const OUT_DIR = path.resolve(os.tmpdir(), 'weftcut-e2e-preview-sw-families')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-preview-sw-families-proj')
const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const SSIM_FLOOR = 0.98

function ffmpegBin(): string | null {
  const cand = process.env.FFMPEG || 'ffmpeg'
  const r = spawnSync(cand, ['-version'], { encoding: 'utf8' })
  return r.status === 0 ? cand : null
}
function parseSsimAll(stderr: string): number | null {
  const m = stderr.match(/All:\s*([0-9]*\.?[0-9]+)/)
  return m ? Number(m[1]) : null
}

interface FamilyCase {
  label: string
  fixture: string
  seekUs: number
  // Assert the delivered ring is the covering frame, not a pre-target keyframe.
  forwardDecodeFloorUs: number
}

async function runFamilyConformance(c: FamilyCase) {
  test.skip(!existsSync(c.fixture), `${c.label} fixture not found at ${c.fixture} — run gen-decode-bench-fixtures.mjs`)
  test.setTimeout(240_000)
  mkdirSync(PROJECT_PARENT, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const { app, page } = await launchApp()
  let toggledOn = false
  try {
    await newProject(page, { parentFolder: PROJECT_PARENT, name: `${c.label}-${Date.now()}`, canvas: CANVAS })
    const after = (await invokeCmd(page, 'app_settings_set', {
      patch: { decode_engine: 'ffmpeg' },
    })) as { decode_engine: string }
    expect(after.decode_engine).toBe('ffmpeg')
    toggledOn = true

    const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: c.fixture })
    expect(kind).toBe('Video')

    await waitForHook(page, 'mediaDecodeRouteKind')
    await page.waitForFunction(
      (id) => (window as { __weftcutTest: { mediaDecodeRouteKind(m: string): string | null } }).__weftcutTest.mediaDecodeRouteKind(id) === 'native-sw',
      mediaId,
      { timeout: 90_000, polling: 500 },
    )
    await page.waitForFunction(
      () => {
        try { (window as { __weftcutTest: { activeClipProbe(id?: string): unknown } }).__weftcutTest.activeClipProbe(); return true } catch { return false }
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )

    // Frame-drop floor: bind an initial frame, then seek far and confirm the
    // sprite STAYS bound (holds last) while decode catches up — never blanks.
    await page.evaluate((us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us), 0)
    await page.waitForFunction(
      (id) => {
        const p = (window as { __weftcutTest: { activeClipProbe(id?: string): { sourceKind: string; spriteBound: boolean; ringSize: number } | null } }).__weftcutTest.activeClipProbe(id)
        return p && p.sourceKind === 'sw' && p.spriteBound && p.ringSize > 0 ? true : null
      },
      layerId,
      { timeout: 90_000, polling: 200 },
    )
    await page.evaluate((us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us), 50_000_000)
    // Immediately (before the far frame can decode) the sprite must remain bound.
    const stillBound = await page.evaluate(
      (id) => (window as { __weftcutTest: { activeClipProbe(id?: string): { spriteBound: boolean } | null } }).__weftcutTest.activeClipProbe(id)?.spriteBound ?? false,
      layerId,
    )
    expect(stillBound, 'frame-drop floor: sprite must hold last frame on a frameAt miss').toBe(true)

    // Seek to the conformance target and wait until the ring holds the SEEKED frame.
    await page.evaluate((us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us), c.seekUs)
    const handle = await page.waitForFunction(
      ([id, target]) => {
        const p = (window as { __weftcutTest: { activeClipProbe(id?: string): {
          sourceKind: string; isSoftware: boolean; ringSize: number; ringFirstPtsUs: number | null; ringLastPtsUs: number | null; spriteBound: boolean
        } | null } }).__weftcutTest.activeClipProbe(id)
        if (!p || p.sourceKind !== 'sw' || p.ringSize < 1 || !p.spriteBound) return null
        if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
        return p
      },
      [layerId, c.seekUs] as const,
      { timeout: 90_000, polling: 200 },
    )
    const probe = (await handle.jsonValue()) as { isSoftware: boolean; ringFirstPtsUs: number | null }
    expect(probe.isSoftware).toBe(true)
    // Long-GOP proof: the ring's earliest frame covers the target — not a pre-target keyframe.
    expect(probe.ringFirstPtsUs ?? 0).toBeGreaterThanOrEqual(c.forwardDecodeFloorUs)

    // SSIM vs an ffmpeg reference of the same source frame.
    const ffmpeg = ffmpegBin()
    test.skip(ffmpeg === null, 'ffmpeg not on PATH (set FFMPEG) — SSIM step skipped')
    const b64 = (await page.evaluate(
      () => (window as { __weftcutTest: { capturePreviewFramePng(): Promise<string> } }).__weftcutTest.capturePreviewFramePng(),
    )) as string
    const rendered = path.join(OUT_DIR, `${c.label}-rendered.png`)
    writeFileSync(rendered, Buffer.from(b64, 'base64'))
    const idx = Math.round((c.seekUs * CANVAS.fpsNum) / (1_000_000 * CANVAS.fpsDen))
    const scores: Array<{ idx: number; ssim: number | null }> = []
    for (const i of [idx - 1, idx, idx + 1].filter((n) => n >= 0)) {
      const reference = path.join(OUT_DIR, `${c.label}-ref-${i}.png`)
      execFileSync(ffmpeg!, ['-y', '-i', c.fixture, '-vf', `select=eq(n\\,${i})`, '-vsync', '0', '-frames:v', '1', reference])
      const r = spawnSync(ffmpeg!, ['-i', rendered, '-i', reference, '-lavfi', '[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim', '-f', 'null', '-'], { encoding: 'utf8' })
      scores.push({ idx: i, ssim: parseSsimAll(r.stderr) })
    }
    const best = scores.reduce<{ idx: number; ssim: number }>((acc, s) => (s.ssim != null && s.ssim > acc.ssim ? { idx: s.idx, ssim: s.ssim } : acc), { idx: -1, ssim: -1 })
    // eslint-disable-next-line no-console
    console.log(`[preview-sw ${c.label}] SSIM scores: ${JSON.stringify(scores)} → best=${JSON.stringify(best)}`)
    expect(best.ssim, `SSIM below floor; scores=${JSON.stringify(scores)}`).toBeGreaterThanOrEqual(SSIM_FLOOR)
  } finally {
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
    }
    await app.close()
  }
}

test('preview-sw: DNxHR (intra) previews via the ffmpeg engine\'s software lane + SSIM', async () => {
  await runFamilyConformance({
    label: 'dnxhr', fixture: path.join(BENCH_DIR, 'dnxhr-1080.mov'),
    seekUs: 500_000, forwardDecodeFloorUs: 0, // intra: any frame is a keyframe
  })
})

test('preview-sw: MPEG-2 (long-GOP) previews the covering frame via the ffmpeg engine\'s software lane + SSIM', async () => {
  await runFamilyConformance({
    label: 'mpeg2', fixture: path.join(BENCH_DIR, 'mpeg2-1080.mpg'),
    seekUs: 800_000, forwardDecodeFloorUs: 700_000, // mid-GOP: ring must NOT hold the ~500ms keyframe
  })
})
