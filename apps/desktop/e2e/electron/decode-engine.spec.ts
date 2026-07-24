import { test, expect, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, tmpDir, waitForHook } from './helpers/driver'

// Decode-engine resolution runtime proof (Task 13 retarget of the old
// D2/tier-resolution spec). The 4-tier `EngineTier` model (`resolveEngineTier`:
// native-hw → webcodecs-original → native-sw → proxy) is GONE. The current
// model is `resolveDecodeEngine` (decodeEngine.ts): it returns
// `{engine: "ffmpeg"|"webcodecs", source: "original"|"proxy", status, reason}`.
// `auto` prefers ffmpeg (any codec) whenever the native component is loaded
// and hasn't failed this session; only falls to webcodecs when the component
// is absent. HW-vs-SW is now INTERNAL to the ffmpeg engine — `FfmpegSource`
// picks its own lane (`currentLane(): "hardware"|"software"`) via
// `pickInitialLane`'s GPU capability probe; it is never a tier/route the
// resolver or these tests choose directly. `activeClipProbe().builtFromKey`
// (Compositor.ts) exposes the resolver's `${engine}:${source}:${target}`
// swap identity, and `sourceKind` already folds in the ffmpeg lane
// ("native-gpu" = hardware, "sw" = software) — see Compositor.activeClipProbe.
//
// Fixtures are synthesized locally (4 s @ 640x360) rather than reused from the
// decode-bench matrix (60 s @ 1080p, e2e/fixtures/decode-bench) so the whole
// spec runs fast; generation self-skips like gen-decode-bench-fixtures.mjs
// when the ffmpeg build on PATH lacks an encoder (CI's fetched static build is
// lean — electron-ci.yml's `ffmpeg:fetch` step).

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
// Fixture paths are assigned in beforeAll under a fresh tmpDir (unique per
// run, auto-swept at worker exit).
let PRORES_FIXTURE: string
// 8-bit H.264 yuv420p — d3d11va-decodable, so the HW capability probe passes
// on a real GPU box. Drives the auto+H.264 cell's hardware-lane resolution.
let H264_FIXTURE: string
// 8-bit AV1 yuv420p — NOT HW-eligible (`hwEligibleCodec` is 8-bit
// h264/hevc/vp9 only, and the app's d3d11va HW probe declines AV1 anyway) but
// IS WebCodecs-decodable (browser AV1/dav1d) AND ffmpeg-decodable (dav1d SW).
// That split drives two cells: the pinned-webcodecs happy path (AV1 decodes
// fine on Lite) and the pinned-ffmpeg pin-override cell (Standard still wins
// even though Lite could have handled it, landing on the software lane since
// AV1 isn't HW-eligible).
let AV1_FIXTURE: string
// Mid-clip seek target (the 4 s fixtures run 0..4_000_000 us) — forces a real
// composite/`ensureClip` pass without landing exactly on frame 0.
const SEEK_US = 1_000_000

function ffmpegBin(): string | null {
  const cand = process.env.FFMPEG || 'ffmpeg'
  const r = spawnSync(cand, ['-version'], { encoding: 'utf8' })
  return r.status === 0 ? cand : null
}

function encoderAvailable(ffmpeg: string, encoder: string): boolean {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.includes(encoder)
}

/// lavfi-synthesized fixture (skip-if-exists mirrors gen-decode-bench-fixtures.mjs).
/// The fixture dir is a fresh tmpDir per run, so repeat runs re-encode into
/// their own dir rather than sharing one.
function genFixture(ffmpeg: string, out: string, codecArgs: string[]): void {
  if (existsSync(out)) return
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=30',
    '-an', ...codecArgs, out,
  ], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`fixture gen failed (${out}):\n${r.stderr.slice(-2000)}`)
}

/// Preview-sw conformance/families' two-step gate: the hook surface mounts
/// async (waitForHook), but `activeClipProbe`/`weftcutSeekUs` additionally
/// throw until `PixiPreview` registers its bridge — poll past that too.
async function waitForPreviewBridge(page: Page): Promise<void> {
  await waitForHook(page, 'mediaDecodeRouteKind')
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
}

/// Subscribe to `media:job_*` BEFORE importing so the burst isn't missed
/// (mirrors media-import.spec.ts). Jobs land in `window.__decodeEngineJobs`.
async function subscribeJobEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __decodeEngineJobs: unknown[] }).__decodeEngineJobs = []
    ;(window as unknown as { api: { on(ev: string, cb: (p: unknown) => void): void } }).api.on(
      'media:job_complete',
      (p: unknown) => {
        ;(window as unknown as { __decodeEngineJobs: unknown[] }).__decodeEngineJobs.push(p)
      },
    )
  })
}

async function waitForJobComplete(page: Page, mediaId: string, kind: string, timeout = 120_000): Promise<void> {
  await page.waitForFunction(
    ({ id, k }) => {
      const evs = (window as unknown as { __decodeEngineJobs: Array<{ media_id: string; kind: string }> })
        .__decodeEngineJobs
      return evs.some((e) => e.media_id === id && e.kind === k)
    },
    { id: mediaId, k: kind },
    { timeout, polling: 500 },
  )
}

interface Probe {
  sourceKind: string
  builtFromKey: string | null
}

/// Poll `activeClipProbe(layerId)` until it reports a `builtFromKey` starting
/// with `prefix` (the resolved `${engine}:${source}` identity), then return it.
/// `sourceKind` filters the resolved lane; pass `null` to match ANY lane and
/// inspect `probe.sourceKind` at the call site (used by the HW-lane cell, which
/// skips rather than fails on a host that resolved to software).
async function waitForBuiltKey(
  page: Page,
  layerId: string,
  sourceKind: string | null,
  prefix: string,
  timeout = 90_000,
): Promise<Probe> {
  const handle = await page.waitForFunction(
    ({ id, sk, pfx }) => {
      const p = (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): Probe | null } })
        .__weftcutTest.activeClipProbe(id)
      if (!p || !p.builtFromKey || !p.builtFromKey.startsWith(pfx)) return null
      if (sk !== null && p.sourceKind !== sk) return null
      return p
    },
    { id: layerId, sk: sourceKind, pfx: prefix },
    { timeout, polling: 250 },
  )
  return (await handle.jsonValue()) as Probe
}

async function seek(page: Page, us: number): Promise<void> {
  await page.evaluate(
    (u) => (window as unknown as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(u),
    us,
  )
}

async function probeNow(page: Page, layerId: string): Promise<Probe> {
  return (await page.evaluate(
    (id) => (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): Probe | null } })
      .__weftcutTest.activeClipProbe(id),
    layerId,
  )) as Probe
}

/// Wait for the UnsupportedClipCard, re-seeking each round to DRIVE our own
/// composites rather than relying on a single async re-composite nudge landing.
/// The import sweep marks a WebCodecs-blind original unusable asynchronously and
/// nudges one `refreshSources()`; under load that lone nudge can be missed, and
/// the card only surfaces on the next composite. Alternating two seek targets
/// forces a fresh `compositeFrame` (→ `ensureClip` re-resolve) each round.
async function waitForUnsupportedCard(
  page: Page,
  seekUs: number,
  timeoutMs = 120_000,
): Promise<void> {
  const card = page.locator('[data-testid="unsupported-clip-card"]')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await card.isVisible().catch(() => false)) return
    if (Date.now() > deadline) break
    await seek(page, seekUs)
    await seek(page, seekUs + 100_000)
    await page.waitForTimeout(400)
  }
  // Final assert so a genuine failure reports through Playwright's matcher.
  await expect(card).toBeVisible({ timeout: 2_000 })
}

test.describe('decode-engine resolution (Electron)', () => {
  // The `encoderAvailable` probes below only defend a LOCAL machine whose
  // ffmpeg lacks an encoder — they do NOT gate CI. CI's fetched ffmpeg builds
  // (gyan "essentials" on Windows, BtbN GPL static on Linux, evermeet on
  // macOS) all bundle libx265 + prores_ks, so the probes would pass there;
  // meanwhile `@weftcut/native-decode` is Windows-only in CI (Task 5), so on
  // the Linux/macOS legs the ProRes cell (which needs the ffmpeg engine) would
  // resolve to webcodecs/unsupported instead and fail. This spec is
  // local-only; require explicit opt-in.
  test.skip(
    process.env.WEFTCUT_DECODE_E2E !== '1',
    'decode-engine e2e is local-only (needs the native-decode component + real encoders); set WEFTCUT_DECODE_E2E=1 to run',
  )

  let ffmpeg: string | null = null

  test.beforeAll(() => {
    ffmpeg = ffmpegBin()
    test.skip(ffmpeg === null, 'ffmpeg not on PATH (set FFMPEG) — decode-engine fixtures need it')
    const outDir = tmpDir('weftcut-e2e-decode-engine-')
    PRORES_FIXTURE = path.join(outDir, 'prores-tier3.mov')
    H264_FIXTURE = path.join(outDir, 'h264-tier1.mp4')
    AV1_FIXTURE = path.join(outDir, 'av1-tier3.mp4')

    test.skip(!encoderAvailable(ffmpeg!, 'prores_ks'), 'ffmpeg build has no prores_ks encoder — ProRes fixture unavailable (lean CI build)')
    genFixture(ffmpeg!, PRORES_FIXTURE, ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'])

    test.skip(!encoderAvailable(ffmpeg!, 'libx264'), 'ffmpeg build has no libx264 encoder — H.264 fixture unavailable (lean CI build)')
    genFixture(ffmpeg!, H264_FIXTURE, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'])

    // libaom-av1 in constant-quality mode with a fast cpu-used so the 4 s clip
    // encodes in seconds (the reference encoder is glacial at its defaults).
    test.skip(!encoderAvailable(ffmpeg!, 'libaom-av1'), 'ffmpeg build has no libaom-av1 encoder — AV1 fixture unavailable (lean CI build)')
    genFixture(ffmpeg!, AV1_FIXTURE, ['-c:v', 'libaom-av1', '-crf', '35', '-b:v', '0', '-cpu-used', '8', '-pix_fmt', 'yuv420p'])
  })

  // Cell 1 — auto + H.264: the ffmpeg engine wins under `auto` whenever the
  // component is loaded (regardless of codec — the old "prefer HW tier, then
  // webcodecs-original tier" ordering is gone). H.264 8-bit yuv420p IS
  // d3d11va-decodable, so `pickInitialLane`'s GPU probe puts `FfmpegSource` on
  // its hardware lane ("native-gpu" in `sourceKind`) on a real GPU box.
  // HW-availability guard: the native `capabilities()` advertises a HW decode
  // lane only on Windows (d3d11va) and Linux (nvdec/vaapi); macOS is
  // software-only, so the engine correctly resolves the SOFTWARE lane and there
  // is no `native-gpu` to observe. The cell then SKIPS (it does not fail),
  // matching the sibling HW specs (preview-gpu-order, preview-hw-conformance).
  test('auto + H.264: resolves ffmpeg on the original — hardware lane when the GPU probe passes', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      const projectParent = tmpDir('weftcut-e2e-decode-engine-proj-')
      await newProject(page, { parentFolder: projectParent, name: 'h264-auto', canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'auto' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('auto')

      const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: H264_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      await seek(page, SEEK_US)
      // Wait for the resolved ffmpeg-original build on EITHER lane (sourceKind
      // null), then decide: `native-gpu` proves the HW probe engaged and the
      // cell asserts; anything else means this host advertises no HW decode lane
      // (e.g. macOS, software-only) and the cell skips rather than failing.
      const probe = await waitForBuiltKey(page, layerId, null, 'ffmpeg:original:')
      test.skip(
        probe.sourceKind !== 'native-gpu',
        `H.264 HW lane not engaged on this host (sourceKind=${probe.sourceKind}) — no HW decode lane advertised (expected on macOS)`,
      )
      expect(probe.sourceKind).toBe('native-gpu')
      expect(probe.builtFromKey!.startsWith('ffmpeg:original:')).toBe(true)
    } finally {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      await app.close()
    }
  })

  // Cell 2 — auto + ProRes: the ffmpeg engine again (no toggle needed — `auto`
  // doesn't care that ProRes is WebCodecs-blind, it just prefers ffmpeg
  // outright). ProRes isn't in `hwEligibleCodec`'s allow-list (h264/hevc/vp9
  // only), so `FfmpegSource` lands on its SOFTWARE lane ("sw" in
  // `sourceKind`). This test doubles as the NO-AUTO-PROXY check (Task 13):
  // the backend still builds a background quick-proxy for this NativeSw-
  // routed clip (decode_route.rs — a still-current, unrelated backend
  // concept; see the `mediaDecodeRouteKind` wait below), but
  // `resolveDecodeEngine` never auto-consumes it (`useProxySource` has no
  // activation path yet — PixiPreview always passes `false`), so the
  // resolved `builtFromKey` must be UNCHANGED after the proxy lands
  // (feedback_native_nle_conventions: no previewPathLive-style auto-swap).
  test('auto + ProRes: resolves ffmpeg on the original (software lane), no toggle — and does not auto-swap onto the landed proxy', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      const projectParent = tmpDir('weftcut-e2e-decode-engine-proj-')
      await newProject(page, { parentFolder: projectParent, name: 'prores-auto', canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'auto' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('auto')

      await subscribeJobEvents(page)
      const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      // Not required for the frontend to acquire (resolveDecodeEngine's ffmpeg
      // branch reads `m.path` directly, independent of `decode_route`), but a
      // cheap sanity check that the backend's independent WebCodecs-blind
      // classification (`DecodeRoute::NativeSw`) landed as expected.
      await page.waitForFunction(
        (id) => (window as unknown as { __weftcutTest: { mediaDecodeRouteKind(m: string): string | null } })
          .__weftcutTest.mediaDecodeRouteKind(id) === 'native-sw',
        mediaId,
        { timeout: 90_000, polling: 500 },
      )
      await seek(page, SEEK_US)
      const probe1 = await waitForBuiltKey(page, layerId, 'sw', 'ffmpeg:original:')
      expect(probe1.sourceKind).toBe('sw')
      expect(probe1.builtFromKey!.startsWith('ffmpeg:original:')).toBe(true)

      // Wait for the background quick-proxy job to actually land, then force
      // one more composite pass (a different seek target) so `ensureClip`
      // re-evaluates `resolveSource` against the now-proxied store state.
      await waitForJobComplete(page, mediaId, 'quick_proxy')
      await seek(page, 0)
      const probe2 = await probeNow(page, layerId)
      expect(probe2.sourceKind).toBe('sw')
      expect(probe2.builtFromKey).toBe(probe1.builtFromKey)
    } finally {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      await app.close()
    }
  })

  // Cell 3 — pinned webcodecs (Lite) + AV1: the happy path for the Lite
  // engine. AV1 is genuinely WebCodecs-decodable (browser AV1/dav1d), so once
  // the import-time decodability sweep (`useImportReadiness`'s
  // `probeSourceDecodable`) confirms it this session, `resolveDecodeEngine`'s
  // webcodecs×original branch resolves "ok" on the original — no proxy
  // needed. Complements Cell 5 below (the unsupported-original half of the
  // Lite engine, currently blocked — see that cell's comment).
  test('pinned webcodecs (Lite) + AV1: resolves webcodecs on the original', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    let toggledOn = false
    try {
      const projectParent = tmpDir('weftcut-e2e-decode-engine-proj-')
      await newProject(page, { parentFolder: projectParent, name: 'av1-webcodecs', canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'webcodecs' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('webcodecs')
      toggledOn = true

      const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: AV1_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      await seek(page, SEEK_US)
      // Long timeout: this cell additionally waits on the import-time
      // WebCodecs-decodability sweep to land "ok" before the resolver can
      // leave "pending".
      const probe = await waitForBuiltKey(page, layerId, 'webcodecs', 'webcodecs:original:', 120_000)
      expect(probe.sourceKind).toBe('webcodecs')
      expect(probe.builtFromKey!.startsWith('webcodecs:original:')).toBe(true)
    } finally {
      if (toggledOn) {
        await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      }
      await app.close()
    }
  })

  // Cell 4 — pinned ffmpeg (Standard) + AV1: proves the PIN overrides the
  // engine-selection axis independent of the lane axis Cell 2 already covers.
  // AV1 IS WebCodecs-decodable (Cell 3 proves it), yet pinning `ffmpeg`
  // still resolves the ffmpeg engine — the setting, not codec decodability,
  // picks the engine. AV1 isn't HW-eligible either, so this also lands on the
  // software lane (same lane Cell 2 hits via `auto`, but reached here via an
  // explicit pin instead of the auto-preference default).
  test('pinned ffmpeg (Standard) + AV1: the pin overrides webcodecs decodability — resolves ffmpeg (software lane)', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    let toggledOn = false
    try {
      const projectParent = tmpDir('weftcut-e2e-decode-engine-proj-')
      await newProject(page, { parentFolder: projectParent, name: 'av1-ffmpeg', canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'ffmpeg' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('ffmpeg')
      toggledOn = true

      const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: AV1_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      await seek(page, SEEK_US)
      const probe = await waitForBuiltKey(page, layerId, 'sw', 'ffmpeg:original:')
      expect(probe.sourceKind).toBe('sw')
      expect(probe.builtFromKey!.startsWith('ffmpeg:original:')).toBe(true)
    } finally {
      if (toggledOn) {
        await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      }
      await app.close()
    }
  })

  // Cell 6 (Task 11, proxy source activation) — Prefer Proxies: the project
  // toggle swaps a heavy source's preview onto its quick proxy. H264_FIXTURE
  // is reused deliberately, NOT swapped for a new fixture: it already routes
  // to DirectExport (has a `quick_proxy` slot), not Bypass. Verified against
  // the real routing policy (proxy_decision.rs) rather than assumed: the
  // lavfi-generated 4 s clip has exactly ONE keyframe (libx264's default GOP
  // is far longer than the 4 s clip), so `probe_max_keyframe_gap_secs`
  // reports the full scan window — way past `MAX_BYPASS_GOP_SECONDS` (0.5 s).
  // `gop_is_scrub_friendly` is therefore false, `source_is_safe_to_bypass`
  // is false, and `decide()` lands on `(export: Original, preview: Proxy)` →
  // `DecodeRoute::DirectExport` (confirmed by generating the identical
  // fixture locally and reading its keyframe pts back with ffprobe: only
  // `0.000000` — a single IDR — comes back). `generate_quick_proxy` (Task 5)
  // then fills the still-empty `quick_proxy` slot on demand, `update_project_
  // settings({prefer_proxies:true})` (Task 1/2) flips the intent, and
  // `resolveDecodeEngine`'s hoisted proxy branch (Task 3/4) resolves
  // `webcodecs:proxy:<url>` regardless of the (default `auto`) decode_engine
  // setting — the `ffmpeg × proxy` landmine fix.
  test('Prefer Proxies: a source with a quick proxy previews from webcodecs:proxy', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      const projectParent = tmpDir('weftcut-e2e-decode-engine-proj-')
      await newProject(page, { parentFolder: projectParent, name: 'proxy-toggle', canvas: CANVAS })
      const { layerId, mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: H264_FIXTURE })

      // Build the quick proxy on demand, then wait until it lands in the route.
      await invokeCmd(page, 'generate_quick_proxy', { mediaId })
      await page.waitForFunction(
        (id) => {
          const m = (window as any).__weftcutTest?.mediaById?.(id)
          const r = m?.decode_route
          return !!r && r.route !== 'bypass' && !!r.quick_proxy
        },
        mediaId,
        { timeout: 120_000 },
      )

      // Flip the project toggle through the REAL renderer setter
      // (setPreferProxies), not the raw update_project_settings command: the
      // resolver gates on the renderer's useProxyPrefStore, which only that
      // setter (or a project_id-change rehydrate) updates — see the
      // E2EHook.setPreferProxies doc comment in e2eHook.ts.
      await page.evaluate(() => (window as any).__weftcutTest.setPreferProxies(true))
      await waitForPreviewBridge(page)
      await seek(page, SEEK_US)
      const probe = await waitForBuiltKey(page, layerId, 'webcodecs', 'webcodecs:proxy:')
      expect(probe.builtFromKey!.startsWith('webcodecs:proxy:')).toBe(true)
    } finally {
      await app.close()
    }
  })

  // Cell 5 — pinned webcodecs (Lite) + ProRes: the unsupported-original half of
  // the Lite engine (complements Cell 3's happy path). ProRes has no WebCodecs
  // decoder, so the import-time decodability sweep (`useImportReadiness` →
  // `classifyWebcodecsDecodability`) returns a DEFINITIVE "unsupported" verdict
  // and `markWebcodecsUnusable` sticks it; `PixiPreview.resolveSource` then
  // feeds `webcodecsCanDecodeOriginal: "fail"`, so `resolveDecodeEngine`'s
  // webcodecs×original branch resolves `status:"unsupported"`. The Compositor
  // fires `onUnsupported`, surfacing the "Switch to Standard" UnsupportedClipCard
  // instead of hanging on "pending" forever.
  //
  // Assert on the card (`data-testid="unsupported-clip-card"`), not
  // `activeClipProbe`: an unsupported resolve builds NO clip, so `activeClipProbe`
  // stays null — the card is the observable surface of `status:"unsupported"`.
  // The sweep marks async and nudges a re-composite, so a generous visibility
  // timeout is enough (no manual re-seek loop needed).
  test('pinned webcodecs (Lite) + ProRes: WebCodecs-unsupported original surfaces the UnsupportedClipCard', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    let toggledOn = false
    try {
      const projectParent = tmpDir('weftcut-e2e-decode-engine-proj-')
      await newProject(page, { parentFolder: projectParent, name: 'prores-webcodecs', canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'webcodecs' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('webcodecs')
      toggledOn = true

      const { kind } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      // The sweep's DEFINITIVE-unsupported verdict + sticky mark land async;
      // once set, a composite resolves status:"unsupported" and mounts the card.
      // Poll with re-seeks rather than trusting the single async nudge — under
      // load that nudge can be missed (see waitForUnsupportedCard).
      await waitForUnsupportedCard(page, SEEK_US)
    } finally {
      if (toggledOn) {
        await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      }
      await app.close()
    }
  })

  // Cell 5b — REGRESSION: switching Lite (webcodecs) onto a ProRes clip that is
  // ALREADY BUILT under auto (ffmpeg) must surface the UnsupportedClipCard. This
  // guards `Compositor.ensureClip`'s existing-clip branch, which used to act
  // ONLY on an "ok" swap: a clip whose resolution flipped to "unsupported" was
  // left on screen with no card (early `return existing`, never
  // `unsupportedMedia.add`). That gap is the mechanism behind Cell 5's
  // under-load flake — `app_settings_set` via the raw command propagates to the
  // renderer store asynchronously, so a first composite can build an ffmpeg clip
  // before the webcodecs pin lands; once the sticky WebCodecs-unusable mark then
  // arrives, the stale ffmpeg clip needs reconciling. Deterministic here because
  // we WAIT for the ffmpeg clip before switching.
  test('switching Lite on a live ffmpeg ProRes clip surfaces the UnsupportedClipCard', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      const projectParent = tmpDir('weftcut-e2e-decode-engine-proj-')
      await newProject(page, { parentFolder: projectParent, name: 'prores-switch', canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'auto' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('auto')

      const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      await seek(page, SEEK_US)
      // Build the ffmpeg-on-original clip first — the "existing clip" the engine
      // switch must reconcile.
      const probe1 = await waitForBuiltKey(page, layerId, 'sw', 'ffmpeg:original:')
      expect(probe1.builtFromKey!.startsWith('ffmpeg:original:')).toBe(true)

      // Now pin Lite: webcodecs cannot decode ProRes, so the live clip must flip
      // to unsupported and surface the card (not stay on the stale ffmpeg frame).
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'webcodecs' } })
      await waitForUnsupportedCard(page, SEEK_US, 90_000)
    } finally {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      await app.close()
    }
  })
})
