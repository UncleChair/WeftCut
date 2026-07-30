import { test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir } from './helpers/driver'

// Runtime verification for the Standard (ffmpeg) engine's HARDWARE decode
// lanes — the sibling of preview-sw-conformance.spec.ts, but for the HW paths.
// It proves that the real app decodes an INTERFRAME 8-bit H.264 clip
// end-to-end through a hardware lane and that the rendered preview frame is
// correct (SSIM vs an ffmpeg reference of the same source frame). Two
// transport shapes share this one spec:
//   - nvdec/vaapi (Linux copy-back): NV12 copies back to system memory and
//     rides the SAME previewSw transport as software (ADR 0034), so
//     everything downstream (ring → Nv12Ingest → sprite) is shared.
//   - d3d11va (Windows shared-texture): frames stay on the GPU; native
//     converts NV12→RGBA with its own shader and shares the texture
//     (GpuTransport). SSIM here is the lane's natural-content structural
//     gate; the matrix/range correctness gate is preview-hw-color.spec.ts.
// Either way `Compositor.activeClipProbe` reports `sourceKind: "native-gpu"`.
//
// PARAMETERIZED BY HARDWARE LANE (issue #5 Block C3). One test() per HW lane in
// {nvdec, vaapi, d3d11va}; each launches the app with WEFTCUT_FORCE_HW_LANE=<lane>, which
// pins main's `decodeCap:probeHw` resolver to consider ONLY that HW lane (plus
// the software fallback). A variant SKIPS CLEANLY when its lane didn't engage on
// this machine — e.g. when the addon never advertised the lane, the resolver
// finds no candidate and falls back to software, so `probe.hwLane === null` and
// the test skips rather than failing. This lets the ONE spec run correctly on a
// box that has NVDEC but not VAAPI (or vice versa) with no per-machine config.
//
// Fixture (8-bit 1080p H.264, interframe, NVDEC/VAAPI-decodable; gitignored,
// generated like the other media fixtures). Regenerate with the static ffmpeg
// CLI:
//   "$FF" -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=2" \
//     -c:v libx264 -profile:v high -pix_fmt yuv420p -g 30 -keyint_min 30 \
//     e2e/fixtures/media/test_1080p_h264.mp4
// (The 10-bit test_1080p_gradient10_h264.mp4 is NOT usable: H.264 High10 isn't
// NVDEC-decodable.)
//
// Model: e2e/electron/preview-sw-conformance.spec.ts. Requires a
// VITE_WEFTCUT_E2E=1 build (the __weftcutTest hook surface) and the current
// native-decode addon (advertising the HW lane under test).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const H264 = path.resolve(MEDIA_DIR, 'test_1080p_h264.mp4')

// Composition + probe target. 500 ms @30 fps = source frame 15; the clip is
// placed 1:1 at t=0, so composition-time 500 ms maps to source frame 15 exactly.
const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const SEEK_US = 500_000
const FRAME_IDX = Math.round((SEEK_US * CANVAS.fpsNum) / (1_000_000 * CANVAS.fpsDen))
const SSIM_FLOOR = 0.98

/// ffmpeg binary: honor an explicit `FFMPEG` override, else rely on PATH.
/// Returns null when ffmpeg can't be executed at all, so the SSIM step degrades
/// to a warning rather than a false failure (the lane-engaged assertion stands).
function ffmpegBin(): string | null {
  const cand = process.env.FFMPEG || 'ffmpeg'
  const r = spawnSync(cand, ['-version'], { encoding: 'utf8' })
  return r.status === 0 ? cand : null
}

/// Parse ffmpeg's `ssim` filter log line: `... All:0.987654 (18.9)`.
function parseSsimAll(stderr: string): number | null {
  const m = stderr.match(/All:\s*([0-9]*\.?[0-9]+)/)
  return m ? Number(m[1]) : null
}

for (const lane of ['nvdec', 'vaapi', 'd3d11va'] as const) {
  test(`preview-hw: ffmpeg engine decodes interframe H.264 on the ${lane} copy-back lane + SSIM (issue #5 Block C3) @serial`, async () => {
    test.skip(!existsSync(H264), `H.264 fixture not found at ${H264} (set WEFTCUT_TEST_MEDIA)`)
    test.setTimeout(240_000)
    const PROJECT_PARENT = tmpDir('weftcut-e2e-preview-hw-proj-')
    const OUT_DIR = tmpDir('weftcut-e2e-preview-hw-')

    // Force the resolver to only consider THIS hardware lane (+ software
    // fallback). On a box that doesn't advertise the lane, the resolver finds no
    // candidate and falls back to software → probe.hwLane === null → clean skip.
    const { app, page } = await launchApp({ env: { WEFTCUT_FORCE_HW_LANE: lane } })
    // Surface renderer console noise (errors are findings for the investigation).
    const consoleLines: string[] = []
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e)}`))

    let toggledOn = false
    try {
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: 'preview-hw-' + lane + '-' + Date.now(),
        canvas: CANVAS,
      })

      // ── Pin the ffmpeg (Standard) engine *before* placing the layer ─────────
      // Engine resolution reads `decode_engine` live at acquire
      // (PixiPreview.resolveSource), so it must be set before the clip is first
      // composited. With `decode_engine: 'ffmpeg'` pinned, `resolveSource` builds
      // a `FfmpegSource` for ANY source by path — h264 is NOT a blind-spot
      // format, so there is NO native-sw route to wait for (that gate is
      // ProRes-specific); the ffmpeg pin alone routes h264 to FfmpegSource.
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'ffmpeg' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('ffmpeg')
      toggledOn = true

      // ── Import + place the H.264 clip ───────────────────────────────────────
      const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: H264 })
      expect(kind).toBe('Video')

      // Ensure the PixiPreview bridge is registered (activeClipProbe throws until
      // it is) before we drive a seek.
      await page.waitForFunction(
        () => {
          try {
            ;(window as { __weftcutTest: { activeClipProbe(id?: string): unknown } }).__weftcutTest.activeClipProbe()
            return true
          } catch {
            return false
          }
        },
        undefined,
        { timeout: 30_000, polling: 250 },
      )

      // Seek ONCE into the clip; poll read-only until the ring holds the SEEKED
      // frame bound to the sprite. Accept either HW (`native-gpu`) or the
      // software fallback (`sw`) here — the fallback is the clean-skip case, sorted
      // out below by inspecting `hwLane`.
      await page.evaluate(
        (us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us),
        SEEK_US,
      )

      const handle = await page.waitForFunction(
        ([id, target]) => {
          const p = (window as { __weftcutTest: { activeClipProbe(id?: string): {
            sourceKind: string
            hwLane: string | null
            ringLastPtsUs: number | null
            spriteBound: boolean
            spriteWidth: number
            spriteHeight: number
          } | null } }).__weftcutTest.activeClipProbe(id)
          if (!p) return null
          if (p.sourceKind !== 'native-gpu' && p.sourceKind !== 'sw') return null
          if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
          if (!p.spriteBound) return null
          return p
        },
        [layerId, SEEK_US] as const,
        { timeout: 90_000, polling: 200 },
      )
      const probe = (await handle.jsonValue()) as {
        sourceKind: string
        hwLane: string | null
        ringLastPtsUs: number | null
        spriteBound: boolean
        spriteWidth: number
        spriteHeight: number
      }

      // ── CLEAN SKIP when the forced lane didn't engage on this machine ───────
      // On this dual-GPU box: nvdec → probe.hwLane === 'nvdec' proceeds; vaapi →
      // the addon didn't advertise it (system libva can't copy-back) → resolver
      // fell back to software → probe.hwLane === null → skip.
      test.skip(
        probe.hwLane !== lane,
        `${lane} not engaged on this machine (hwLane=${probe.hwLane}, sourceKind=${probe.sourceKind}) — lane unavailable`,
      )

      // ── The whole point: the HW copy-back lane engaged and produced the frame ──
      expect(probe.sourceKind).toBe('native-gpu')
      expect(probe.hwLane).toBe(lane)
      expect(probe.spriteBound).toBe(true)
      expect(probe.spriteWidth).toBe(CANVAS.width)
      expect(probe.spriteHeight).toBe(CANVAS.height)

      // ── Rendered preview frame matches an ffmpeg reference (SSIM ≥ 0.98) ─────
      const ffmpeg = ffmpegBin()
      test.skip(ffmpeg === null, 'ffmpeg not available on PATH (set FFMPEG) — SSIM skipped; lane-engaged proof stands')

      // Capture the LIVE composited preview frame at composition resolution.
      const b64 = (await page.evaluate(
        () => (window as { __weftcutTest: { capturePreviewFramePng(): Promise<string> } }).__weftcutTest.capturePreviewFramePng(),
      )) as string
      const rendered = path.join(OUT_DIR, `rendered-${lane}.png`)
      writeFileSync(rendered, Buffer.from(b64, 'base64'))

      // Compare against the SAME source frame decoded by ffmpeg. Robust to a ±1
      // sub-frame PTS-rounding discrepancy between the native seek and ffmpeg's
      // frame index by taking the best of the target frame and its immediate
      // neighbors (a garbage decode matches NONE at 0.98).
      const scores: Array<{ idx: number; ssim: number | null }> = []
      for (const idx of [FRAME_IDX - 1, FRAME_IDX, FRAME_IDX + 1].filter((n) => n >= 0)) {
        const reference = path.join(OUT_DIR, `reference-${lane}-${idx}.png`)
        execFileSync(ffmpeg!, [
          '-y', '-i', H264,
          '-vf', `select=eq(n\\,${idx})`,
          '-vsync', '0', '-frames:v', '1', reference,
        ])
        const r = spawnSync(ffmpeg!, [
          '-i', rendered, '-i', reference,
          '-lavfi', '[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim',
          '-f', 'null', '-',
        ], { encoding: 'utf8' })
        scores.push({ idx, ssim: parseSsimAll(r.stderr) })
      }
      const best = scores.reduce<{ idx: number; ssim: number }>(
        (acc, s) => (s.ssim != null && s.ssim > acc.ssim ? { idx: s.idx, ssim: s.ssim } : acc),
        { idx: -1, ssim: -1 },
      )
      // eslint-disable-next-line no-console
      console.log(`[preview-hw:${lane}] SSIM scores: ${JSON.stringify(scores)} → best=${JSON.stringify(best)}`)
      expect(best.ssim, `SSIM below floor; scores=${JSON.stringify(scores)}`).toBeGreaterThanOrEqual(SSIM_FLOOR)

      // Renderer errors during the run are findings.
      const errs = consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
      // eslint-disable-next-line no-console
      if (errs.length) console.log(`[preview-hw:${lane}] renderer errors during run:\n` + errs.join('\n'))
    } finally {
      // Restore the app-level setting so the run doesn't leave the machine pinned
      // to native (it persists cross-project).
      if (toggledOn) {
        await invokeCmd(page, 'app_settings_set', {
          patch: { decode_engine: 'auto' },
        }).catch(() => {})
      }
      await app.close()
    }
  })
}
