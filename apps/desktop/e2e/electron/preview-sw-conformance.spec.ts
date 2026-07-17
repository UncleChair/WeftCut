import { test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, waitForHook } from './helpers/driver'

// Runtime verification for the native software-decode ProRes preview
// (Task 13 retarget: the collapsed engine model, ADR 0030). This is the ONE
// proof Task 8b was missing: that the preview Compositor actually acquires a
// `FfmpegSource` on its SOFTWARE lane for a `DecodeRoute::NativeSw`-routed
// ProRes clip — the whole real-app path (import → Rust proxy_decision routes
// `NativeSw` → PixiPreview.resolveSource resolves the ffmpeg engine →
// Compositor.ensureClip acquires it → FfmpegSource's SwTransport rings NV12
// as NativeNv12Frames → Nv12Ingest → sprite). Plus an SSIM
// color/decode-correctness check of the rendered preview frame vs an ffmpeg
// reference of the same source frame. NOTE: this natural-content SSIM is
// alignment/decode evidence only — it is structurally blind to a 601↔709
// matrix swap (chroma weighs ~1/6); preview-sw-color.spec.ts is the color gate.
//
// Model: e2e/electron/conformance.spec.ts. Requires a VITE_WEFTCUT_E2E=1
// build (the __weftcutTest hook surface) and the current preview-sw
// native/index.*.node.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const PRORES = path.resolve(MEDIA_DIR, 'test_1080p_30fps_prores.mov')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-preview-sw-proj')
const OUT_DIR = path.resolve(os.tmpdir(), 'weftcut-e2e-preview-sw')

// Composition + probe target. 500 ms @30 fps = source frame 15; the clip is
// placed 1:1 at t=0 (src_in_us=0), so composition-time 500 ms maps to source
// frame 15 exactly (snapFrameFloor(500000,30,1) = 500000 = frame 15 PTS).
const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const SEEK_US = 500_000
const FRAME_IDX = Math.round((SEEK_US * CANVAS.fpsNum) / (1_000_000 * CANVAS.fpsDen))
const SSIM_FLOOR = 0.98

// P3 (memory ratchet). The generated 4K ProRes bench fixture (60 s, 3840×2160).
const PRORES_4K = path.resolve(MEDIA_DIR, '../decode-bench/prores-2160.mov')
const CANVAS_4K = { width: 3840, height: 2160, fpsNum: 30, fpsDen: 1 }
// Post-GC renderer private-memory growth ceiling across a churn of 4K SW
// decodes. Matches the dev playback ratchet's 30 MB gate (memory-ratchet.mjs):
// a properly-evicting FrameRing settles near-zero regardless of frame size, so
// a real leak (ImageBitmaps not released) blows well past this.
const RATCHET_MB = 30

/// ffmpeg binary: honor an explicit `FFMPEG` override, else rely on PATH
/// (the controller sets `$env:FFMPEG_DIR\bin` on PATH — see the task's run
/// instructions). Returns null when ffmpeg can't be executed at all, so P2
/// degrades to a warning rather than a false failure (P1 is the gate).
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

test('preview-sw: Compositor uses the ffmpeg engine\'s software lane for the NativeSw-routed ProRes clip + SSIM (Task 8b runtime proof)', async () => {
  test.skip(!existsSync(PRORES), `ProRes fixture not found at ${PRORES} (set WEFTCUT_TEST_MEDIA)`)
  test.setTimeout(240_000)
  mkdirSync(PROJECT_PARENT, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const { app, page } = await launchApp()
  // Surface renderer console noise (warnings are findings per the task).
  const consoleLines: string[] = []
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e)}`))

  let toggledOn = false
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'preview-sw-' + Date.now(),
      canvas: CANVAS,
    })

    // ── Pin the ffmpeg (Standard) engine *before* placing the layer ─────────
    // Engine resolution reads `decode_engine` live at acquire
    // (PixiPreview.resolveSource), so it must be set before the clip is
    // first composited. Written through the same `app_settings_set` IPC the UI
    // uses; the backend emits `app_settings:changed` which hydrates the
    // renderer store (read by resolveSource).
    const after = (await invokeCmd(page, 'app_settings_set', {
      patch: { decode_engine: 'ffmpeg' },
    })) as { decode_engine: string }
    expect(after.decode_engine).toBe('ffmpeg')
    toggledOn = true

    // ── Import + place the ProRes clip ──────────────────────────────────────
    const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES })
    expect(kind).toBe('Video')

    // ── Wait for the async proxy-decision to commit the NativeSw route ──────
    // ProRes routes PreviewSource::NativeFfmpeg → DecodeRoute::NativeSw
    // (proxy_decision.rs) — a still-current, unrelated backend concept (not
    // the deleted frontend tier model): it's the "does this original need a
    // proxy at all" decision, independent of resolveDecodeEngine's ffmpeg/
    // webcodecs choice. Not strictly required for the frontend to acquire
    // (resolveDecodeEngine's ffmpeg branch reads `m.path` directly), but a
    // cheap sanity check that the backend's classification landed — gate the
    // seek on it being live.
    await waitForHook(page, 'mediaDecodeRouteKind')
    await page.waitForFunction(
      (id) => (window as { __weftcutTest: { mediaDecodeRouteKind(m: string): string | null } }).__weftcutTest.mediaDecodeRouteKind(id) === 'native-sw',
      mediaId,
      { timeout: 90_000, polling: 500 },
    )

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

    let probe: {
      sourceKind: string
      isSoftware: boolean
      sourceDisposed: boolean
      ringSize: number
      ringFirstPtsUs: number | null
      ringLastPtsUs: number | null
      spriteBound: boolean
      spriteWidth: number
      spriteHeight: number
    } | null = null

    await test.step('P1 — active clip source is a live FfmpegSource (software lane) with the seeked frame decoded + bound', async () => {
      // Seek ONCE into the clip. seek() sets scrubbing=true and re-composites
      // (which runs ensureClip → acquires the FfmpegSource on its software
      // lane); the scrub
      // coalescer then clears scrubbing and issues the real decoder
      // requestFrameAt, whose native session seeks to the target (ProRes is
      // intra) and decodes the frame. Re-seeking on every poll would restart
      // the debounce and starve setAnchorTime, so we seek once and poll
      // read-only. Wait until the ring actually holds the SEEKED frame
      // (ringLastPtsUs >= target) — the ring surfaces the nearest decoded frame
      // while catching up, so an early poll would otherwise bind frame ~0.
      await page.evaluate(
        (us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us),
        SEEK_US,
      )

      const handle = await page.waitForFunction(
        ([id, target]) => {
          const p = (window as { __weftcutTest: { activeClipProbe(id?: string): {
            sourceKind: string; ringSize: number; ringLastPtsUs: number | null; spriteBound: boolean
          } | null } }).__weftcutTest.activeClipProbe(id)
          if (!p) return null
          if (p.sourceKind !== 'sw') return null
          if (p.ringSize < 1) return null
          if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
          if (!p.spriteBound) return null
          return p
        },
        [layerId, SEEK_US] as const,
        { timeout: 90_000, polling: 200 },
      )
      probe = (await handle.jsonValue()) as typeof probe

      // The whole point: the Compositor's active clip source is a
      // FfmpegSource on its software lane (native software decode), not the
      // WebCodecs SourceHandle or the ffmpeg hardware lane.
      expect(probe!.sourceKind).toBe('sw')
      expect(probe!.isSoftware).toBe(true)
      expect(probe!.sourceDisposed).toBe(false)
      // A decoded frame (NV12 ringed as a NativeNv12Frame) reached the ring,
      // including the seeked target frame…
      expect(probe!.ringSize).toBeGreaterThan(0)
      expect(probe!.ringLastPtsUs).toBeGreaterThanOrEqual(SEEK_US)
      // …and a frame was bound to the sprite at the source's real dimensions.
      expect(probe!.spriteBound).toBe(true)
      expect(probe!.spriteWidth).toBe(CANVAS.width)
      expect(probe!.spriteHeight).toBe(CANVAS.height)
    })

    await test.step('P2 — rendered preview frame matches an ffmpeg reference (SSIM ≥ 0.98)', async () => {
      const ffmpeg = ffmpegBin()
      test.skip(ffmpeg === null, 'ffmpeg not available on PATH (set FFMPEG or FFMPEG_DIR) — P2 skipped; P1 stands')

      // Capture the LIVE composited preview frame at composition resolution.
      const b64 = (await page.evaluate(
        () => (window as { __weftcutTest: { capturePreviewFramePng(): Promise<string> } }).__weftcutTest.capturePreviewFramePng(),
      )) as string
      const rendered = path.join(OUT_DIR, 'rendered.png')
      writeFileSync(rendered, Buffer.from(b64, 'base64'))

      // Compare against the SAME source frame decoded by ffmpeg. The preview's
      // NV12 (8-bit 4:2:0) downconvert of the 10-bit ProRes source means SSIM
      // is < 1.0 by construction; the structural score must still clear 0.98.
      // Robust to a ±1 sub-frame PTS-rounding discrepancy between the native
      // seek and ffmpeg's frame index by taking the best of the target frame
      // and its immediate neighbors (a garbage decode matches NONE at 0.98).
      const scores: Array<{ idx: number; ssim: number | null }> = []
      for (const idx of [FRAME_IDX - 1, FRAME_IDX, FRAME_IDX + 1].filter((n) => n >= 0)) {
        const reference = path.join(OUT_DIR, `reference-${idx}.png`)
        execFileSync(ffmpeg!, [
          '-y', '-i', PRORES,
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
      console.log(`[preview-sw] SSIM scores: ${JSON.stringify(scores)} → best=${JSON.stringify(best)}`)
      expect(best.ssim, `SSIM below floor; scores=${JSON.stringify(scores)}`).toBeGreaterThanOrEqual(SSIM_FLOOR)
    })

    // Renderer errors during the run are findings.
    const errs = consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
    // eslint-disable-next-line no-console
    if (errs.length) console.log('[preview-sw] renderer errors during run:\n' + errs.join('\n'))
  } finally {
    // Restore the app-level setting so the run doesn't leave the machine
    // pinned to native (it persists cross-project).
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'auto' },
      }).catch(() => {})
    }
    await app.close()
  }
})

test('preview-sw: 4K ProRes software preview stays within the memory ratchet (P3)', async () => {
  test.skip(!existsSync(PRORES_4K), `4K ProRes bench fixture not found at ${PRORES_4K} (generate via e2e/scripts/gen-decode-bench-fixtures.mjs)`)
  test.setTimeout(240_000)
  mkdirSync(PROJECT_PARENT, { recursive: true })

  const { app, page } = await launchApp()
  let toggledOn = false
  try {
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'preview-sw-4k-' + Date.now(),
      canvas: CANVAS_4K,
    })
    const after = (await invokeCmd(page, 'app_settings_set', {
      patch: { decode_engine: 'ffmpeg' },
    })) as { decode_engine: string }
    expect(after.decode_engine).toBe('ffmpeg')
    toggledOn = true

    const { mediaId, layerId } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES_4K })
    await waitForHook(page, 'mediaDecodeRouteKind')
    await page.waitForFunction(
      (id) => (window as { __weftcutTest: { mediaDecodeRouteKind(m: string): string | null } }).__weftcutTest.mediaDecodeRouteKind(id) === 'native-sw',
      mediaId,
      { timeout: 90_000, polling: 500 },
    )
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

    // Confirm we really are on the ffmpeg engine's software lane at 4K before measuring.
    await page.evaluate((us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us), 1_000_000)
    const kind = await page.waitForFunction(
      (id) => {
        const p = (window as { __weftcutTest: { activeClipProbe(id?: string): { sourceKind: string; ringSize: number } | null } }).__weftcutTest.activeClipProbe(id)
        return p && p.sourceKind === 'sw' && p.ringSize > 0 ? p.sourceKind : null
      },
      layerId,
      { timeout: 60_000, polling: 200 },
    ).then((h) => h.jsonValue())
    expect(kind).toBe('sw')

    // Forced-GC renderer private-memory floor (mirrors memory-ratchet.mjs):
    // collect twice with settle waits, then read the max renderer 'Tab'
    // privateBytes via getAppMetrics.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable').catch(() => {})
    const rendererPrivMB = async (): Promise<number> => {
      const ms = (await app.evaluate(async ({ app: a }) =>
        a.getAppMetrics().map((m) => ({ type: m.type, privKB: m.memory.privateBytes ?? 0 })),
      )) as Array<{ type: string; privKB: number }>
      return Math.round(Math.max(...ms.filter((m) => m.type === 'Tab').map((m) => m.privKB), 0) / 1024)
    }
    const gcFloor = async (): Promise<number> => {
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
      await new Promise((r) => setTimeout(r, 3_000))
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
      await new Promise((r) => setTimeout(r, 4_000))
      return rendererPrivMB()
    }

    // Warm the pipeline with an initial sweep so the baseline reflects
    // steady-state (decoder + ring allocated), isolating the leak signal.
    const churn = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const us = (i % 120) * 500_000 // 0 .. 59.5 s across the 60 s clip
        // eslint-disable-next-line no-await-in-loop
        await page.evaluate((u) => (window as { __weftcutTest: { weftcutSeekUs(u: number): void } }).__weftcutTest.weftcutSeekUs(u), us)
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120))
      }
    }
    await churn(15)
    const floorA = await gcFloor()

    // Churn 4K SW decodes hard: 120 seeks spanning the whole clip force the
    // ring to fill + evict repeatedly — the exact path a leak would ratchet.
    await churn(120)
    const floorB = await gcFloor()
    const ratchet = floorB - floorA
    // eslint-disable-next-line no-console
    console.log(`[preview-sw] 4K SW-preview memory: floorA=${floorA}MB floorB=${floorB}MB ratchet=${ratchet}MB (ceiling ${RATCHET_MB}MB)`)

    expect(ratchet, `4K SW-preview ratcheted ${ratchet}MB over the churn (floorA=${floorA}, floorB=${floorB})`).toBeLessThan(RATCHET_MB)
  } finally {
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'auto' },
      }).catch(() => {})
    }
    await app.close()
  }
})
