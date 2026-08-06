// Transitions v1 determinism + WYSIWYG gate.
//
// Solid RED → solid BLUE Color layers (no media files, no decode variance)
// make every assertion mathematical: per transition kind the spec authors a
// two-layer timeline through the REAL agent command surface (the MCP
// add_transition/update_transition tools), samples fixed composition times
// from the LIVE preview compositor, exports the same project, decodes the
// SAME timestamps from the output file with ffmpeg, and runs the IDENTICAL
// assertions on both — that equality is the WYSIWYG claim (preview and
// export share the two-input transition node; see
// src/renderer/render/transitions/).
//
// Sampled geometry mirrors transitionSources.ts (direction = MOTION direction,
// screen space); each VARIANTS entry derives its own p = 0.5 expectation. Probe
// points sit ≥ 40 px away from the boundary column, safely past codec chroma
// bleed.
//
// Tolerance: ±40/channel. Preview readback is near-exact (±2); the export
// leg absorbs H.264 4:2:0 round-trip loss plus a worst-case 601↔709 matrix
// relabel (~26 counts on saturated primaries — see color-conformance.spec's
// header). 40 stays far below the 127-count RED↔MIX↔BLUE spacing, so a
// wrong-kind / wrong-direction / wrong-progress render cannot pass.
//
// Failure artifacts: every sampled frame (preview PNG + decoded export PNG)
// is written to the test's Playwright output dir (test-results/…), so a red
// run always leaves the actual pixels next to the failing assertion.

import { test, expect, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { launchApp, newProject, invokeCmd, driveExport, tmpDir } from './helpers/driver'

// ── Composition + timeline shape ─────────────────────────────────────────────
// RED [0, 2s] + BLUE [2s, 4s] on ONE track; add_transition (start-at-cut)
// extends RED to 3s, window = [2s, 3s). 30 fps ⇒ the sampled times land on
// exact output frame indices (frameTimeUs(i) = round(i·1e6/30)).
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const CUT_US = 2_000_000
const TRANSITION_US = 1_000_000
const RED = { r: 255, g: 0, b: 0 }
const BLUE = { r: 0, g: 0, b: 255 }
const MIX = { r: 128, g: 0, b: 128 } // mix(RED, BLUE, 0.5) in encoded space
const TOL = 40

// Sampled composition times: window midpoint (progress exactly 0.5) plus one
// point before and one after the window.
const TIMES = {
  before: 1_500_000, // RED only (window starts at 2s)
  mid: 2_500_000, // progress = (2.5s − 2s) / 1s = 0.5
  after: 3_500_000, // BLUE only (window ends at 3s; RED tail ends at 3s)
} as const
type TimeName = keyof typeof TIMES
const frameIndexAt = (us: number) => Math.round((us * CANVAS.fpsNum) / (1_000_000 * CANVAS.fpsDen))

// Probe columns (composition px, y = 180): two per half, the near pair 40 px
// off the boundary column at x = 320 to pin "boundary at center".
const PROBE_Y = 180
const PROBE_X = { left: 160, nearLeft: 280, nearRight: 360, right: 480 } as const
type PointName = keyof typeof PROBE_X

interface Rgb { r: number; g: number; b: number }
type FrameSamples = Record<PointName, Rgb>
type FrameExpectation = Record<PointName, Rgb>

const uniform = (c: Rgb): FrameExpectation => ({ left: c, nearLeft: c, nearRight: c, right: c })
/// left half `l`, right half `r` — the p=0.5 boundary-at-center geometry.
const halves = (l: Rgb, r: Rgb): FrameExpectation => ({ left: l, nearLeft: l, nearRight: r, right: r })

interface Variant {
  name: string
  kind: 'Crossfade' | 'Wipe' | 'Slide'
  direction?: 'left' | 'right' | 'up' | 'down'
  mid: FrameExpectation
}

// before/after are kind-independent (outside the window): all-RED / all-BLUE.
const EXPECT_BEFORE = uniform(RED)
const EXPECT_AFTER = uniform(BLUE)

// ── Pure assertion core — shared verbatim by the preview and export legs ────
/// Compare sampled frames against expectations; returns human-readable
/// mismatch lines (empty = pass). Kept pure so BOTH legs run the exact same
/// math — the WYSIWYG equality is this function being green twice.
function frameMismatches(
  label: string,
  got: Partial<Record<TimeName, FrameSamples>>,
  want: Record<TimeName, FrameExpectation>,
): string[] {
  const errs: string[] = []
  for (const timeName of Object.keys(want) as TimeName[]) {
    const frame = got[timeName]
    if (!frame) {
      errs.push(`${label}/${timeName}: frame not sampled`)
      continue
    }
    for (const pt of Object.keys(PROBE_X) as PointName[]) {
      const g = frame[pt]
      const e = want[timeName][pt]
      for (const ch of ['r', 'g', 'b'] as const) {
        if (Math.abs(g[ch] - e[ch]) > TOL) {
          errs.push(
            `${label}/${timeName} @${pt}(${PROBE_X[pt]},${PROBE_Y}): ${ch}=${g[ch]} want ${e[ch]}±${TOL} ` +
              `(got r=${g.r} g=${g.g} b=${g.b})`,
          )
        }
      }
    }
  }
  return errs
}

// ── ffmpeg (export decode) ───────────────────────────────────────────────────
/// Honor an explicit FFMPEG override, else PATH (run-e2e's preflight wires the
/// bundled resources/ffmpeg/<os> binaries into both). Null ⇒ cannot decode the
/// export — the gate skips rather than passing vacuously.
function ffmpegBin(): string | null {
  const cand = process.env.FFMPEG || 'ffmpeg'
  const r = spawnSync(cand, ['-version'], { stdio: 'ignore' })
  return r.status === 0 ? cand : null
}

/// Decode frame `n` (0-based decode index) of `mp4` to a PNG. select=eq(n,N)
/// decodes from the start — frame-accurate, unlike a -ss time seek (same
/// approach as the media_conformance analyzer). The output PNG doubles as the
/// failure artifact for this sampled timestamp.
function extractFramePng(ffmpeg: string, mp4: string, n: number, outPng: string): void {
  execFileSync(ffmpeg, [
    '-y', '-hide_banner', '-nostats', '-loglevel', 'error',
    '-i', mp4,
    '-vf', `select=eq(n\\,${n})`,
    '-frames:v', '1', '-vsync', '0',
    outPng,
  ])
}

function samplePngPoints(pngPath: string): FrameSamples {
  const png = PNG.sync.read(fs.readFileSync(pngPath))
  if (png.width !== CANVAS.width || png.height !== CANVAS.height) {
    throw new Error(`decoded export frame is ${png.width}x${png.height}, want ${CANVAS.width}x${CANVAS.height}`)
  }
  const out = {} as FrameSamples
  for (const pt of Object.keys(PROBE_X) as PointName[]) {
    const i = (PROBE_Y * png.width + PROBE_X[pt]) * 4
    out[pt] = { r: png.data[i]!, g: png.data[i + 1]!, b: png.data[i + 2]! }
  }
  return out
}

// ── Preview sampling ─────────────────────────────────────────────────────────
/// Seek the live preview and read the probe points off the composited canvas.
/// weftcutSeekUs throws until the PixiPreview bridge registers; the caller's
/// readiness poll absorbs that window, so here a failure is real.
async function collectPreviewFrame(page: Page, tUs: number): Promise<FrameSamples> {
  await page.evaluate((us) => (window as any).__weftcutTest.weftcutSeekUs(us), tUs)
  // Color layers need no decode; one short settle covers the re-composite.
  await page.waitForTimeout(200)
  const out = {} as FrameSamples
  for (const pt of Object.keys(PROBE_X) as PointName[]) {
    const s = (await page.evaluate(
      ([x, y]) => (window as any).__weftcutTest.weftcutSampleComposite(x, y),
      [PROBE_X[pt], PROBE_Y] as const,
    )) as { r: number; g: number; b: number }
    out[pt] = { r: s.r, g: s.g, b: s.b }
  }
  return out
}

async function collectPreviewFrames(page: Page): Promise<Record<TimeName, FrameSamples>> {
  const out = {} as Record<TimeName, FrameSamples>
  for (const timeName of Object.keys(TIMES) as TimeName[]) {
    out[timeName] = await collectPreviewFrame(page, TIMES[timeName])
  }
  return out
}

/// Poll until the preview reflects the authored timeline + transition (the
/// project:changed bridge and first composite land asynchronously after the
/// MCP commit), with a hard deadline. Convergence is checked with the SAME
/// expectation table the strict assertion uses — on a broken build the poll
/// times out and the strict assertion then reports the real pixel values.
async function waitPreviewSettled(
  page: Page,
  want: Record<TimeName, FrameExpectation>,
  timeoutMs = 30_000,
): Promise<Record<TimeName, FrameSamples>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<TimeName, FrameSamples> | null = null
  for (;;) {
    try {
      last = await collectPreviewFrames(page)
      if (frameMismatches('poll', last, want).length === 0) return last
    } catch {
      // Preview bridge not registered yet — keep polling.
    }
    if (Date.now() > deadline) {
      if (!last) throw new Error('preview bridge never became ready')
      return last // strict assertion downstream reports the real pixel values
    }
    await page.waitForTimeout(400)
  }
}

/// Capture the composited preview PNG at each sampled time into the test's
/// output dir — the preview-side failure artifacts.
async function dumpPreviewArtifacts(page: Page, prefix: string): Promise<void> {
  for (const timeName of Object.keys(TIMES) as TimeName[]) {
    await page.evaluate((us) => (window as any).__weftcutTest.weftcutSeekUs(us), TIMES[timeName])
    await page.waitForTimeout(200)
    const b64 = (await page.evaluate(() => (window as any).__weftcutTest.capturePreviewFramePng())) as string
    fs.writeFileSync(test.info().outputPath(`${prefix}-preview-${timeName}.png`), Buffer.from(b64, 'base64'))
  }
}

// ── MCP (the agent command surface) ──────────────────────────────────────────
async function connectMcp(page: Page): Promise<Client> {
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as {
    url: string
    bearer_token: string
  }
  const transport = new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  })
  const client = new Client({ name: 'transitions-wysiwyg', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

function toolText(res: unknown): string {
  return (structuredClone((res as { content: unknown }).content) as Array<{ text: string }>)[0]!.text
}

// ── The gate ─────────────────────────────────────────────────────────────────
const VARIANTS: Variant[] = [
  { name: 'crossfade', kind: 'Crossfade', mid: uniform(MIX) },
  // Wipe left: boundary sweeps right-to-left ⇒ incoming revealed from the
  // right edge ⇒ right half BLUE at p = 0.5.
  { name: 'wipe-left', kind: 'Wipe', direction: 'left', mid: halves(RED, BLUE) },
  // Slide left: incoming enters from the right edge moving left ⇒ its left
  // edge sits at center at p = 0.5 — same half/half geometry.
  { name: 'slide-left', kind: 'Slide', direction: 'left', mid: halves(RED, BLUE) },
]

for (const variant of VARIANTS) {
  test(`transitions WYSIWYG: ${variant.name} — preview and export pass identical midpoint/before/after assertions`, async () => {
    // Local-only like the other export gates: the export leg needs the real
    // GPU/WebCodecs encode path, absent on headless CI.
    test.skip(
      process.env.WEFTCUT_E2E_NO_EXPORT === '1',
      'transition export leg needs a real GPU/WebCodecs encoder not on headless CI; verified locally',
    )
    const ffmpeg = ffmpegBin()
    test.skip(ffmpeg === null, 'ffmpeg not available (set FFMPEG or run `npm run ffmpeg:fetch`) — cannot decode the export leg')
    test.setTimeout(240_000)

    const { app, page } = await launchApp()
    let mcp: Client | null = null
    try {
      await newProject(page, {
        parentFolder: tmpDir('weftcut-e2e-transitions-proj-'),
        name: `transitions-${variant.name}-` + Date.now(),
        canvas: CANVAS,
      })

      // ── Author: RED [0,2s] + BLUE [2s,4s] on ONE track, then the transition
      // through the real MCP tool (the agent command surface).
      const trackId = await invokeCmd<string>(page, 'add_track', {})
      const redId = await invokeCmd<string>(page, 'add_color_layer', {
        trackId,
        color: { ...RED, a: 255 },
        tStartUs: 0,
        durationUs: CUT_US,
      })
      const blueId = await invokeCmd<string>(page, 'add_color_layer', {
        trackId,
        color: { ...BLUE, a: 255 },
        tStartUs: CUT_US,
        durationUs: CUT_US,
      })

      mcp = await connectMcp(page)
      const addRes = await mcp.callTool({
        name: 'add_transition',
        arguments: {
          from_layer_id: redId,
          to_layer_id: blueId,
          duration_us: TRANSITION_US,
          kind: variant.kind,
          ...(variant.direction ? { direction: variant.direction } : {}),
        },
      })
      const transitionId = toolText(addRes)
      expect(transitionId.length).toBeGreaterThan(0)

      // State sanity: start-at-cut extended RED's tail by the duration and the
      // transition is in the read surface with its full shape.
      const summary = (await invokeCmd(page, 'project_summary', {})) as {
        tracks: Array<{ layers: Array<{ id: string; t_end_us: number }> }>
        transitions: Array<{ id: string; from_layer: string; to_layer: string; duration_us: number; kind: Record<string, unknown> }>
      }
      const red = summary.tracks.flatMap((t) => t.layers).find((l) => l.id === redId)
      expect(red?.t_end_us, 'add_transition extends the outgoing layer by duration (start-at-cut)').toBe(
        CUT_US + TRANSITION_US,
      )
      expect(summary.transitions).toHaveLength(1)
      expect(summary.transitions[0]).toMatchObject({
        id: transitionId,
        from_layer: redId,
        to_layer: blueId,
        duration_us: TRANSITION_US,
        kind: { kind: variant.kind, ...(variant.direction ? { direction: variant.direction } : {}) },
      })

      const want: Record<TimeName, FrameExpectation> = {
        before: EXPECT_BEFORE,
        mid: variant.mid,
        after: EXPECT_AFTER,
      }

      // ── Preview leg ────────────────────────────────────────────────────────
      await waitPreviewSettled(page, want)
      const previewFrames = await collectPreviewFrames(page)
      await dumpPreviewArtifacts(page, variant.name)
      const previewErrs = frameMismatches(`preview/${variant.name}`, previewFrames, want)
      expect(previewErrs, previewErrs.join('\n')).toEqual([])

      // ── Export leg — decode the SAME timestamps, run the SAME assertions ───
      const output = path.join(tmpDir('weftcut-e2e-transitions-out-'), `${variant.name}.mp4`)
      const exp = await driveExport(page, { outputAbsPath: output }, { hook: 'exportTimeline', timeout: 150_000 })
      if (!exp.done.ok) throw new Error(`exportTimeline failed (${variant.name}): ${exp.done.error}`)

      // Duration autofit ⇒ 4s @ 30fps ⇒ exactly 120 planned frames.
      const perf = (await page.evaluate(() => (window as any).__weftcutExportPerf ?? null)) as
        | { totalFrames: number }
        | null
      expect(perf, '__weftcutExportPerf must be set after export (E2E build)').not.toBeNull()
      expect(perf!.totalFrames, '4s composition at 30fps plans 120 frames').toBe(120)

      const exportFrames = {} as Record<TimeName, FrameSamples>
      for (const timeName of Object.keys(TIMES) as TimeName[]) {
        const png = test.info().outputPath(`${variant.name}-export-${timeName}.png`)
        extractFramePng(ffmpeg!, output, frameIndexAt(TIMES[timeName]), png)
        exportFrames[timeName] = samplePngPoints(png)
      }
      const exportErrs = frameMismatches(`export/${variant.name}`, exportFrames, want)
      expect(
        exportErrs,
        exportErrs.join('\n') + `\n(sampled frames in ${test.info().outputDir})`,
      ).toEqual([])

      console.log(
        `[transitions-wysiwyg] ${variant.name}: preview=${JSON.stringify(previewFrames.mid)} ` +
          `export=${JSON.stringify(exportFrames.mid)} (mid frame ${frameIndexAt(TIMES.mid)})`,
      )

      // ── Direction spot-check (Wipe only): update_transition flips the
      // geometry — left half becomes the incoming side. Preview-only (cheap);
      // the left-direction export above already pinned preview≡export.
      if (variant.kind === 'Wipe') {
        await mcp.callTool({
          name: 'update_transition',
          arguments: { transition_id: transitionId, kind: 'Wipe', direction: 'right' },
        })
        const mirrored: Record<TimeName, FrameExpectation> = {
          before: EXPECT_BEFORE,
          mid: halves(BLUE, RED),
          after: EXPECT_AFTER,
        }
        await waitPreviewSettled(page, mirrored)
        const rightFrames = await collectPreviewFrames(page)
        await dumpPreviewArtifacts(page, 'wipe-right')
        const rightErrs = frameMismatches('preview/wipe-right', rightFrames, mirrored)
        expect(rightErrs, rightErrs.join('\n')).toEqual([])
      }
    } finally {
      await mcp?.close().catch(() => {})
      await app.close()
    }
  })
}
