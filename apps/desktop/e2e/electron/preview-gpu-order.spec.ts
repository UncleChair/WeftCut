import { test, expect, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'

// Frame-CONTENT-order regression guard for the ffmpeg engine's HARDWARE
// (d3d11va GPU) lane preview. The Phase-D manual HW smoke found that this
// lane presents B-frame content OUT OF ORDER during forward playback
// (jumps/repeats/reverses) even though the ring self-sorts by PTS — i.e. the
// bitmap paired with a PTS carried a DIFFERENT frame's pixels (the
// shared-texture slot read/ack coherence race). The decode-bench never
// caught it because throughput/seek measure fps + frame COUNT, never
// CONTENT.
//
// This drives `decodeBenchOrderCheck` against an index-encoded clip (each
// presentation frame N carries a 12-stripe binary barcode of N) through the
// REAL renderer ffmpeg-engine hardware-lane path (private SourceDecoderPool,
// `engine: 'ffmpeg'` + `forceLane: 'hardware'` → `FfmpegSource` → shared-
// texture import → createImageBitmap), and asserts every delivered bitmap's
// barcode matches its pts-derived index.
//
// Local-only (needs the Windows @weftcut/native-decode component + a GPU whose
// d3d11va decodes HEVC): gated on WEFTCUT_DECODE_E2E=1 like decode-engine.spec.
// Requires a VITE_WEFTCUT_E2E=1 build (the __weftcutTest hook surface).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIP = path.resolve(__dirname, '../fixtures/decode-bench/order-hevc-648.mp4')

const CLIP_META = {
  fpsNum: 30,
  fpsDen: 1,
  frameCount: 300,
  width: 1152,
  height: 648,
  bits: 12,
}

/// Enter the editor so a PREVIEW SURFACE exists before any hardware session runs.
///
/// A bare `launchApp()` sits on the project picker with zero canvases, so the
/// Pixi Application — and therefore the device the shipped barrier takes its
/// completion signal on — never initializes. The probes below drive a PRIVATE
/// decoder pool and do not need the Compositor, which is exactly how a run in
/// that state used to pass: every session quietly took the readback fallback and
/// the gate certified a barrier nobody had exercised. The product never decodes
/// on the hardware lane without a preview surface up; this makes the gate run in
/// that same state, and the per-session barrier assertion is what proves it.
async function enterEditorWithPreview(page: Page): Promise<void> {
  await newProject(page, {
    parentFolder: tmpDir('weftcut-order-'),
    name: `order-${Date.now()}`,
    canvas: { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 },
  })
  // A layer is what mounts the surface: an empty project shows "preview starts
  // after you add a layer" and never creates the Application. A colour layer is
  // the cheapest one and has nothing to decode, so it cannot compete with the
  // probes' own hardware sessions.
  await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 1_000_000 })
  // Non-null `previewResourceProbe` == PixiPreview's onInit ran (it installs the
  // bridge the probe reads), which is also where the device is registered.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as {
              __weftcutTest?: { previewResourceProbe?: () => unknown }
            }).__weftcutTest?.previewResourceProbe?.() ?? null,
        ),
      { timeout: 60_000, message: 'preview surface never mounted' },
    )
    .not.toBeNull()
}

interface OrderCheckMismatch { ptsUs: number; expectedIdx: number; decodedIdx: number }
interface OrderCheckResult {
  strategy: string
  poolSize: number | null
  checked: number
  missing: number
  mismatches: OrderCheckMismatch[]
  barrierApplied?: string | null
  error?: string
}

/// The barrier a hardware-lane run must be able to prove it ran. A barcode check
/// passes under every CORRECT barrier, so green says nothing about WHICH one was
/// exercised: a variant that could not get the context it needs falls back — by
/// design and without a word — and the run then certifies the fallback under the
/// pinned variant's name. Held to the product default when the env is unset, so
/// keep this in step with `HW_BARRIER_DEFAULT` in src/main/previewGpu.ts.
const EXPECTED_BARRIER = process.env.WEFTCUT_HW_BARRIER ?? 'rendererFence'

function expectBarrierRan(applied: string | null | undefined, where: string): void {
  expect(
    applied,
    `${where}: no barrier observed — the run cannot say which variant it exercised`,
  ).not.toBeNull()
  expect(
    applied,
    `${where}: ran the "${applied}" barrier, not the pinned "${EXPECTED_BARRIER}" — this run did not test the thing`,
  ).toBe(EXPECTED_BARRIER)
}

async function runOrderCheck(
  page: Page,
  strategy: 'native' | 'sw',
  poolSize?: number,
): Promise<OrderCheckResult> {
  await waitForHook(page, 'decodeBenchOrderCheck')
  return (await page.evaluate(
    (args) =>
      (window as unknown as {
        __weftcutTest: { decodeBenchOrderCheck(a: unknown): Promise<OrderCheckResult> }
      }).__weftcutTest.decodeBenchOrderCheck(args),
    { sourcePath: CLIP, strategy, ...CLIP_META, ...(poolSize !== undefined ? { poolSize } : {}) },
  )) as OrderCheckResult
}

function report(r: OrderCheckResult): string {
  const head = `strategy=${r.strategy} pool=${r.poolSize} barrier=${r.barrierApplied ?? 'none-observed'} checked=${r.checked} missing=${r.missing} mismatches=${r.mismatches.length}${r.error ? ` error=${r.error}` : ''}`
  const ex = r.mismatches
    .slice(0, 12)
    .map((m) => `  pts=${m.ptsUs} expected=${m.expectedIdx} decoded=${m.decodedIdx} (Δ=${m.decodedIdx - m.expectedIdx})`)
    .join('\n')
  return ex ? `${head}\n${ex}` : head
}

interface ConcurrentOrderSession {
  index: number
  lane: string
  checked: number
  missing: number
  mismatches: OrderCheckMismatch[]
  timedOut: boolean
  barrierApplied?: string | null
  error?: string
}
interface ConcurrentOrderResult {
  poolSize: number | null
  sessions: ConcurrentOrderSession[]
  error?: string
}

async function runConcurrentOrderCheck(page: Page, sessions: number): Promise<ConcurrentOrderResult> {
  await waitForHook(page, 'decodeBenchConcurrentOrderCheck')
  return (await page.evaluate(
    (args) =>
      (window as unknown as {
        __weftcutTest: { decodeBenchConcurrentOrderCheck(a: unknown): Promise<ConcurrentOrderResult> }
      }).__weftcutTest.decodeBenchConcurrentOrderCheck(args),
    { sourcePath: CLIP, sessions, ...CLIP_META },
  )) as ConcurrentOrderResult
}

function reportSession(s: ConcurrentOrderSession): string {
  const head = `  session ${s.index}: lane=${s.lane} barrier=${s.barrierApplied ?? 'none-observed'} checked=${s.checked} missing=${s.missing} mismatches=${s.mismatches.length}${s.timedOut ? ' TIMED-OUT' : ''}${s.error ? ` error=${s.error}` : ''}`
  const ex = s.mismatches
    .slice(0, 6)
    .map((m) => `    pts=${m.ptsUs} expected=${m.expectedIdx} decoded=${m.decodedIdx} (Δ=${m.decodedIdx - m.expectedIdx})`)
    .join('\n')
  return ex ? `${head}\n${ex}` : head
}

function reportConcurrent(r: ConcurrentOrderResult): string {
  return `pool=${r.poolSize}${r.error ? ` error=${r.error}` : ''}\n${r.sessions.map(reportSession).join('\n')}`
}

/// Every assertion a concurrent hardware-lane run owes, applied per session.
/// Shared by the fixed-three run and the at-cap run so the two cannot drift into
/// checking different things about the same probe; `sessions` rides the messages
/// because the contention level is the first thing a shortfall has to report.
function expectConcurrentRunInOrder(r: ConcurrentOrderResult, sessions: number): void {
  expect(r.error, `concurrent order check errored: ${r.error}`).toBeUndefined()
  expect(r.sessions.length, `expected ${sessions} session results`).toBe(sessions)
  for (const s of r.sessions) {
    expect(s.error, `session ${s.index} errored: ${s.error}\n${reportConcurrent(r)}`).toBeUndefined()
    // A session on software has not tested the hardware path. Fail rather
    // than report its ordering under a hardware label.
    expect(
      s.lane,
      `session ${s.index} ran on "${s.lane}", not hardware — this run did not test the thing:\n${reportConcurrent(r)}`,
    ).toBe('hardware')
    // Per session: the barrier latch is per stream, so one session running a
    // different variant than its siblings is drift this must not bury.
    expectBarrierRan(s.barrierApplied, `session ${s.index}`)
    // Short `checked` under contention is a CAPACITY finding, not a reason
    // to lower the bar — the message carries every session's numbers so the
    // shortfall can be read directly.
    expect(
      s.checked,
      `session ${s.index} checked only ${s.checked} frames${s.timedOut ? ' (ran out of budget)' : ''} — ${sessions} concurrent sessions did not sustain throughput:\n${reportConcurrent(r)}`,
    ).toBeGreaterThan(200)
    expect(
      s.missing,
      `session ${s.index} never received ${s.missing} frame(s):\n${reportConcurrent(r)}`,
    ).toBeLessThan(30)
    expect(
      s.mismatches.length,
      `session ${s.index} presented ${s.mismatches.length} frame(s) whose pixels did not match their PTS (reorder under ${sessions}-session contention):\n${reportConcurrent(r)}`,
    ).toBe(0)
  }
}

interface HwFallbackSessionOutcome {
  index: number
  ready: boolean
  lane: string
  error: string | null
}
interface HwFallbackProbeResult {
  sessions: HwFallbackSessionOutcome[]
  lastRingPushCountBefore: number
  lastRingPushCountAfter: number
  error?: string
}

async function runHwFallbackProbe(page: Page, count: number): Promise<HwFallbackProbeResult> {
  await waitForHook(page, 'decodeBenchHwFallbackProbe')
  return (await page.evaluate(
    (args) =>
      (window as unknown as {
        __weftcutTest: { decodeBenchHwFallbackProbe(a: unknown): Promise<HwFallbackProbeResult> }
      }).__weftcutTest.decodeBenchHwFallbackProbe(args),
    {
      sourcePath: CLIP,
      codec: 'hevc',
      pixFmt: 'yuv420p',
      width: CLIP_META.width,
      height: CLIP_META.height,
      count,
    },
  )) as HwFallbackProbeResult
}

/// The largest concurrent hardware shape THIS fixture can occupy, read from the
/// same live `previewGpu:budget` bridge as the renderer. Admission has two
/// constraints (session slots + coded pixel area), so using only
/// `sessions.max` can ask a large fixture to open a shape main must refuse.
///
/// Call on a freshly launched app, where nothing owns a reservation. The
/// subtraction still matters: it keeps this helper honest if a future fixture
/// setup begins decoding before the check.
async function readLargestConcurrentForFixture(
  page: Page,
  width: number,
  height: number,
): Promise<number> {
  const budget = (await page.evaluate(() =>
    (window as unknown as {
      api: {
        previewGpu: {
          budget(): Promise<{
            currency: 'coded-pixel-area'
            sessions: { used: number; max: number }
            codedPixelArea: { used: number; max: number; calibratedFps: 30 }
          }>
        }
      }
    }).api.previewGpu.budget(),
  )) as {
    currency: 'coded-pixel-area'
    sessions: { used: number; max: number }
    codedPixelArea: { used: number; max: number; calibratedFps: 30 }
  }
  expect(budget.currency).toBe('coded-pixel-area')
  expect(
    budget.sessions.max,
    `previewGpu budget reported no hardware-session cap: ${JSON.stringify(budget)}`,
  ).toBeGreaterThan(0)
  const fixtureArea = width * height
  expect(
    Number.isSafeInteger(fixtureArea) && fixtureArea > 0,
    `invalid order-fixture coded size ${width}x${height}`,
  ).toBe(true)
  const sessionSlots = budget.sessions.max - budget.sessions.used
  const areaFits = Math.floor(
    (budget.codedPixelArea.max - budget.codedPixelArea.used) / fixtureArea,
  )
  const largestConcurrent = Math.min(sessionSlots, areaFits)
  expect(
    largestConcurrent,
    `previewGpu budget cannot admit even one ${width}x${height} order fixture: ${JSON.stringify(budget)}`,
  ).toBeGreaterThan(0)
  return largestConcurrent
}

test.describe('ffmpeg engine hardware lane preview presents frames in order (Electron) @serial', () => {
  test.skip(
    process.env.WEFTCUT_DECODE_E2E !== '1',
    'ffmpeg hardware-lane order guard is local-only (needs the native-decode component + a GPU that d3d11va-decodes HEVC); set WEFTCUT_DECODE_E2E=1 to run',
  )
  test.skip(!existsSync(CLIP), `index-encoded fixture not found at ${CLIP} (generate via e2e/scripts/gen-order-fixture.mjs)`)

  // Swept across pool sizes because the reorder corrupted frame N with the
  // frame POOL_SIZE ahead (decoded = expected + pool_size): a fix that only held
  // at the production default (3) would be a coincidence, and a future pool
  // change would silently reopen the hole. pool=1 is the tightest race (every
  // slot read contends the very next frame).
  for (const poolSize of [1, 3, 5]) {
    test(`ffmpeg hardware lane (pool=${poolSize}): every delivered frame's pixels match its PTS (no reorder)`, async () => {
      test.setTimeout(180_000)
      const { app, page } = await launchApp()
      try {
        await enterEditorWithPreview(page)
        const r = await runOrderCheck(page, 'native', poolSize)
        // eslint-disable-next-line no-console
        console.log(`[preview-gpu-order] hardware lane pool=${poolSize} ->\n` + report(r))
        expect(r.error, `order check errored: ${r.error}`).toBeUndefined()
        // The clip has 300 frames; a functioning lane reads essentially all of
        // them. A near-empty run means decode failed, not that order is "fine".
        expect(r.checked, 'too few frames checked — hardware-lane decode did not run').toBeGreaterThan(200)
        expectBarrierRan(r.barrierApplied, `hardware lane pool=${poolSize}`)
        expect(
          r.mismatches.length,
          `hardware lane (pool=${poolSize}) presented ${r.mismatches.length} frame(s) whose pixels did not match their PTS (reorder):\n${report(r)}`,
        ).toBe(0)
      } finally {
        await app.close()
      }
    })
  }

  // The single-session sweep above cannot speak for the case we ship. Three
  // concurrent hardware sessions is production's problem shape, and the barrier
  // behaves differently there: the synchronous readback measures ~19ms of drain at
  // one session but ~5ms at three, because the sessions share one flush and
  // per-session slack collapses as sessions are added. Any strategy whose
  // ordering depends on GPU command-queue depth when it submits can therefore
  // pass alone and reorder in company — and would ship green, since every other
  // gate in this repo drives one session.
  //
  // Each session is asserted on its own: a merged count would let two passes
  // bury one session's reorder, and "which session" is the first thing a
  // failure has to answer. Barrier mode comes from WEFTCUT_HW_BARRIER, same as
  // every test here.
  test('ffmpeg hardware lane: 3 concurrent sessions each present frames in order (no reorder under contention)', async () => {
    test.setTimeout(240_000)
    const { app, page } = await launchApp()
    try {
      await enterEditorWithPreview(page)
      const r = await runConcurrentOrderCheck(page, 3)
      // eslint-disable-next-line no-console
      console.log('[preview-gpu-order] 3 concurrent hardware sessions ->\n' + reportConcurrent(r))
      expectConcurrentRunInOrder(r, 3)
    } finally {
      await app.close()
    }
  })

  // The same probe at the largest concurrent shape this fixture's live budget
  // admits. The fixed-three run
  // above is not superseded by this one: three sessions still leave the most
  // barrier slack of any multi-session shape (see the drain numbers above), which
  // makes it the multi-session case most likely to HIDE a reorder. This run
  // covers the shape production actually ships once the cap moves past three,
  // where per-session slack is thinnest.
  //
  // The session count comes from the live budget rather than a literal because
  // `decodeBenchConcurrentOrderCheck` refuses a shape exceeding either live
  // constraint (see `readLargestConcurrentForFixture`) — a hard-coded count
  // ahead of a budget change would fail the run,
  // not skip it. While the cap is still three this run would only repeat the test
  // above, so it skips.
  //
  // Same 240s as the fixed-three run: the hook's drive budget is ONE shared 90s
  // wall clock for all sessions, deliberately unscaled (a run that cannot walk
  // the clip in the single-session budget IS the capacity answer), so adding
  // sessions does not extend the work this has to wait out.
  test('ffmpeg hardware lane: largest admitted concurrent fixture shape presents frames in order', async () => {
    test.setTimeout(240_000)
    const { app, page } = await launchApp()
    try {
      const cap = await readLargestConcurrentForFixture(page, CLIP_META.width, CLIP_META.height)
      test.skip(
        cap <= 3,
        `largest admitted fixture shape is ${cap} — this run would be identical to the 3-session test above`,
      )
      await enterEditorWithPreview(page)
      const r = await runConcurrentOrderCheck(page, cap)
      // eslint-disable-next-line no-console
      console.log(`[preview-gpu-order] ${cap} concurrent hardware sessions (largest admitted fixture shape) ->\n` + reportConcurrent(r))
      expectConcurrentRunInOrder(r, cap)
    } finally {
      await app.close()
    }
  })

  // Smoke item b — HW admission budget → downgrade (runtime seam), FORCED lane.
  // Main admits this fixture up to the smaller of session slots and coded-area
  // fits; the (cap+1)th open must reject with `hw-budget-exceeded` and surface it via
  // onFatalError (the resolver's downgrade-off-tier-1 on that marker is
  // unit-tested in ffmpegCapability.test.ts). This opens cap+1 real sessions with
  // the lane FORCED (`forceLane: 'hardware'`), which bypasses `FfmpegSource`'s
  // in-place HW→SW recovery by design (`_doEnsureReady`'s catch only recovers
  // when `!forceLane`) — the bench harness needs this hard-fatal behavior for
  // deterministic hardware-only measurement. See the REAL (unforced) fallback
  // test below for the production in-place-recovery path.
  test('ffmpeg hardware lane (forced): the over-budget concurrent session hits hw-budget-exceeded (budget → fatal)', async () => {
    test.setTimeout(120_000)
    const { app, page } = await launchApp()
    try {
      const cap = await readLargestConcurrentForFixture(page, CLIP_META.width, CLIP_META.height)
      await waitForHook(page, 'decodeBenchBudgetProbe')
      const r = (await page.evaluate(
        (args) =>
          (window as unknown as {
            __weftcutTest: { decodeBenchBudgetProbe(a: unknown): Promise<{ outcomes: Array<{ index: number; ready: boolean; error: string | null; fatalReason: string | null }>; error?: string }> }
          }).__weftcutTest.decodeBenchBudgetProbe(args),
        {
          sourcePath: CLIP,
          width: CLIP_META.width,
          height: CLIP_META.height,
          count: cap + 1,
        },
      )) as { outcomes: Array<{ index: number; ready: boolean; error: string | null; fatalReason: string | null }>; error?: string }
      // eslint-disable-next-line no-console
      console.log(`[preview-gpu-order] budget (forced lane, cap=${cap}) ->\n` + JSON.stringify(r.outcomes, null, 2))
      expect(r.error, `budget probe errored: ${r.error}`).toBeUndefined()
      // Every open up to this fixture's largest admitted shape opens cleanly.
      expect(r.outcomes.slice(0, cap).every((o) => o.ready), `first ${cap} hardware-lane sessions should open`).toBe(true)
      // The (cap+1)th is rejected at the cap, and the budget reason reaches the
      // handle's fatal path (what drives the resolver's sticky downgrade).
      const overBudget = r.outcomes[cap]!
      expect(overBudget.ready, `session ${cap} must NOT open (past the ${cap}-fixture admission shape)`).toBe(false)
      expect(overBudget.error ?? '', 'the over-budget open should reject with hw-budget-exceeded').toContain('hw-budget-exceeded')
      expect(overBudget.fatalReason ?? '', 'onFatalError should carry the budget reason').toContain('hw-budget-exceeded')
    } finally {
      await app.close()
    }
  })

  // HW→SW in-place fallback (Task 13) — a REAL budget-rejection trigger, not
  // an injected error. Opens the largest admitted fixture shape + 1 real ffmpeg-engine
  // sources on this HW-eligible clip WITHOUT forcing a lane —
  // `pickInitialLane`'s real GPU capability probe puts each on hardware
  // exactly as production does (see decodeBench.ts's
  // `decodeBenchHwFallbackProbe` doc comment). The over-budget one's HW `open()`
  // genuinely trips `hw-budget-exceeded`; because nothing forced its lane,
  // `FfmpegSource._doEnsureReady`'s catch engages the SAME in-place HW→SW
  // recovery a runtime GPU error uses — the ring survives, `ensureReady()`
  // resolves normally (not a fatal), and `currentLane()` reads "software"
  // afterward.
  //
  // "No source-swap fired": this driver acquires ONE `FfmpegSource` per
  // session directly off a private `SourceDecoderPool` (the same bench-style
  // harness the order-check/budget-probe tests above use) — there is no live
  // Compositor in the loop, so Compositor's swap machinery (`beginSwap`/
  // `SwapState`) never runs here at all. The over-budget session's recovery
  // happens INSIDE its one `FfmpegSource` instance (never disposed/re-acquired
  // across the test), so "no swap" is inherent to how the probe drives it, not a
  // separate counter to assert.
  test('ffmpeg hardware lane: the first over-budget fixture session survives via in-place HW→SW fallback', async () => {
    test.setTimeout(120_000)
    const { app, page } = await launchApp()
    try {
      const cap = await readLargestConcurrentForFixture(page, CLIP_META.width, CLIP_META.height)
      const r = await runHwFallbackProbe(page, cap + 1)
      // eslint-disable-next-line no-console
      console.log(`[preview-gpu-order] hw-fallback (unforced, cap=${cap}) ->\n` + JSON.stringify(r, null, 2))
      expect(r.error, `hw-fallback probe errored: ${r.error}`).toBeUndefined()
      expect(r.sessions.length).toBe(cap + 1)
      const hw = r.sessions.slice(0, cap)
      const spilled = r.sessions[cap]!
      // Every session within this fixture's admitted shape opens cleanly on the hardware lane
      // (the real HW probe passes for this HEVC 8-bit fixture on a GPU that
      // d3d11va-decodes it). Asserted per session, with its index in the message,
      // so ONE session landing on the wrong lane is identifiable from the failure.
      for (const s of hw) {
        expect(s.ready, `session ${s.index} (within the ${cap}-session budget) should open`).toBe(true)
        expect(s.lane, `session ${s.index} (within the ${cap}-session budget) should open on the hardware lane, got "${s.lane}"`).toBe('hardware')
      }
      // The over-budget one trips the budget, but recovers IN PLACE — ensureReady
      // still resolves (ready=true), and the final lane is software.
      expect(spilled.ready, 'the over-budget session must recover, not fail, after the budget rejection').toBe(true)
      expect(spilled.lane, 'the over-budget session must have fallen back to the software lane').toBe('software')
      // And it keeps delivering real frames on the new (software) transport —
      // the ring genuinely grows, not just a resolved promise.
      expect(
        r.lastRingPushCountAfter,
        `over-budget session's ring never grew after fallback (before=${r.lastRingPushCountBefore} after=${r.lastRingPushCountAfter})`,
      ).toBeGreaterThan(r.lastRingPushCountBefore)
    } finally {
      await app.close()
    }
  })

  // Control: the ffmpeg engine's SOFTWARE lane shares the ring + the barcode
  // reader but NOT the shared-texture slot pool. It must pass — proving any
  // hardware-lane failure above is the GPU slot path, not a harness/clip/
  // reader artifact.
  test('ffmpeg software lane (control): presents the same clip in order', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      const r = await runOrderCheck(page, 'sw')
      // eslint-disable-next-line no-console
      console.log('[preview-gpu-order] software lane (control) ->\n' + report(r))
      expect(r.error, `order check errored: ${r.error}`).toBeUndefined()
      expect(r.checked, 'too few frames checked — software-lane decode did not run').toBeGreaterThan(200)
      expect(
        r.mismatches.length,
        `software lane (control) reordered — harness/clip/reader is suspect, not the GPU path:\n${report(r)}`,
      ).toBe(0)
    } finally {
      await app.close()
    }
  })
})
