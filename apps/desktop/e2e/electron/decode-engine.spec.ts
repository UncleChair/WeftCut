import { test, expect, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, waitForHook } from './helpers/driver'

// D2 tier-resolution runtime proof (Task 10): `resolveEngineTier`'s pure order
// (auto = native-hw → webcodecs-original → native-sw → proxy; webcodecs =
// webcodecs-original → proxy) was unit-tested in decodeEngine.test.ts, but
// never driven through the REAL Compositor. `activeClipProbe().builtFromKey`
// (Compositor.ts, extended by this task) exposes the resolver's `${tier}:
// ${target}` identity so these cells can assert the resolved TIER directly —
// `sourceKind` alone can't distinguish webcodecs-original from proxy (both
// decode through the WebCodecs pool and report `sourceKind: "webcodecs"`).
//
// Fixtures are synthesized locally (4 s @ 640x360) rather than reused from the
// decode-bench matrix (60 s @ 1080p, e2e/fixtures/decode-bench) so the whole
// spec runs fast; generation self-skips like gen-decode-bench-fixtures.mjs
// when the ffmpeg build on PATH lacks an encoder (CI's fetched static build is
// lean — electron-ci.yml's `fetch-ffmpeg` step).

const OUT_DIR = path.resolve(os.tmpdir(), 'weftcut-e2e-decode-engine')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-decode-engine-proj')
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const PRORES_FIXTURE = path.join(OUT_DIR, 'prores-tier3.mov')
// 8-bit H.264 yuv420p — d3d11va-decodable, so the HW capability probe passes
// on a real GPU box. Drives Cell 5's tier-1 (native-hw) production path.
const H264_FIXTURE = path.join(OUT_DIR, 'h264-tier1.mp4')
// 8-bit AV1 yuv420p — NOT HW-eligible (the allow-list is 8-bit H.264/HEVC/VP9,
// and the app's d3d11va HW probe declines AV1 anyway), while WebCodecs decodes
// it (browser AV1) AND the LGPL ffmpeg (dav1d) SW-decodes it. That split lets
// ONE fixture drive two cells: Cell 1's tier-2 (webcodecs-original under `auto`,
// since HW is skipped and WebCodecs wins the original), and Cell 4's PROBE-
// driven tier-3 (native-sw under pinned `native`, HW skipped → SW). AV1 is also
// NOT on the native-SW blind-spot list (ProRes/DNxHD/MPEG-2/VC-1), so Cell 4's
// SW lane is lit by the PROBE, not the static route seed.
const AV1_FIXTURE = path.join(OUT_DIR, 'av1-tier3.mp4')
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

/// Idempotent lavfi-synthesized fixture (mirrors gen-decode-bench-fixtures.mjs'
/// skip-if-exists idiom) — repeat local runs don't re-encode.
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

/// Poll `activeClipProbe(layerId)` until it reports `sourceKind` and a
/// `builtFromKey` starting with `prefix` (the resolved TIER), then return it.
async function waitForTier(
  page: Page,
  layerId: string,
  sourceKind: string,
  prefix: string,
  timeout = 90_000,
): Promise<Probe> {
  const handle = await page.waitForFunction(
    ({ id, sk, pfx }) => {
      const p = (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): Probe | null } })
        .__weftcutTest.activeClipProbe(id)
      if (!p || p.sourceKind !== sk || !p.builtFromKey || !p.builtFromKey.startsWith(pfx)) return null
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

test.describe('decode-engine tier resolution (Electron)', () => {
  // The `encoderAvailable` probes below only defend a LOCAL machine whose
  // ffmpeg lacks an encoder — they do NOT gate CI. CI's fetched ffmpeg builds
  // (gyan "essentials" on Windows, BtbN GPL static on Linux, evermeet on
  // macOS) all bundle libx265 + prores_ks, so the probes would pass there;
  // meanwhile `@weftcut/native-decode` is Windows-only in CI (Task 5), so on
  // the Linux/macOS legs Cell 2 (auto/ProRes → native-sw) would resolve to
  // proxy instead and fail. This spec is local-only; require explicit opt-in.
  test.skip(
    process.env.WEFTCUT_DECODE_E2E !== '1',
    'decode-engine tier e2e is local-only (needs the native-decode component + real encoders); set WEFTCUT_DECODE_E2E=1 to run',
  )

  let ffmpeg: string | null = null

  test.beforeAll(() => {
    ffmpeg = ffmpegBin()
    test.skip(ffmpeg === null, 'ffmpeg not on PATH (set FFMPEG) — decode-engine tier fixtures need it')
    mkdirSync(OUT_DIR, { recursive: true })
    mkdirSync(PROJECT_PARENT, { recursive: true })

    test.skip(!encoderAvailable(ffmpeg!, 'prores_ks'), 'ffmpeg build has no prores_ks encoder — ProRes fixture unavailable (lean CI build)')
    genFixture(ffmpeg!, PRORES_FIXTURE, ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'])

    test.skip(!encoderAvailable(ffmpeg!, 'libx264'), 'ffmpeg build has no libx264 encoder — H.264 fixture unavailable (lean CI build)')
    genFixture(ffmpeg!, H264_FIXTURE, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'])

    // libaom-av1 in constant-quality mode with a fast cpu-used so the 4 s clip
    // encodes in seconds (the reference encoder is glacial at its defaults).
    test.skip(!encoderAvailable(ffmpeg!, 'libaom-av1'), 'ffmpeg build has no libaom-av1 encoder — AV1 fixture unavailable (lean CI build)')
    genFixture(ffmpeg!, AV1_FIXTURE, ['-c:v', 'libaom-av1', '-crf', '35', '-b:v', '0', '-cpu-used', '8', '-pix_fmt', 'yuv420p'])
  })

  // Cell 1 — auto + AV1: tier 2 (webcodecs-original) ends the proxy-default era.
  // This must use a codec that resolves webcodecs-original under `auto`. HEVC
  // used to prove this, but D4 widened the HW allow-list to include HEVC, so
  // HEVC now wins tier 1 (native-hw) on this GPU. AV1 is the tier-2 witness that
  // survives D4: it is NOT HW-eligible (allow-list is 8-bit H.264/HEVC/VP9, and
  // the d3d11va probe declines AV1), so the resolver skips tier 1 and WebCodecs
  // decodes the ORIGINAL AV1 file directly — tier 2, no proxy. AV1 8-bit routes
  // export=Original / preview=Proxy on the backend (proxy_decision::
  // av1_8bit_exports_original_previews_proxy), so a quick proxy WILL still land
  // in the background. The resolver keys on tier+target though
  // (feedback_native_nle_conventions): a landed proxy can never displace an
  // already-higher tier, so `builtFromKey` must be UNCHANGED afterward.
  test('auto + AV1: resolves webcodecs-original (tier 2) and does not swap when the proxy lands', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'av1-auto-' + Date.now(), canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'auto' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('auto')

      await subscribeJobEvents(page)
      const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: AV1_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      await seek(page, 0)
      const probe1 = await waitForTier(page, layerId, 'webcodecs', 'webcodecs-original:')
      expect(probe1.sourceKind).toBe('webcodecs')
      expect(probe1.builtFromKey!.startsWith('webcodecs-original:')).toBe(true)

      // Wait for the background quick-proxy job to actually land, then force
      // one more composite pass (a different seek target) so `ensureClip`
      // re-evaluates `resolveSource` against the now-proxied store state.
      await waitForJobComplete(page, mediaId, 'quick_proxy')
      await seek(page, SEEK_US)
      const probe2 = await probeNow(page, layerId)
      expect(probe2.sourceKind).toBe('webcodecs')
      expect(probe2.builtFromKey).toBe(probe1.builtFromKey)
    } finally {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      await app.close()
    }
  })

  // Cell 2 — auto + ProRes: the WebCodecs-blind family resolves native-sw
  // (tier 3) with NO toggle — `resolveEngineTier`'s 'auto' order tries tier 2
  // first, but ProRes fails the WebCodecs decodability probe on every
  // machine, so it falls through to tier 3 as soon as the persisted route
  // commits `native-sw` (codec_is_blindspot routes preview to NativeFfmpeg).
  test('auto + ProRes: resolves native-sw (tier 3) — the blind-spot family, no toggle needed', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'prores-auto-' + Date.now(), canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'auto' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('auto')

      const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      await page.waitForFunction(
        (id) => (window as unknown as { __weftcutTest: { mediaDecodeRouteKind(m: string): string | null } })
          .__weftcutTest.mediaDecodeRouteKind(id) === 'native-sw',
        mediaId,
        { timeout: 90_000, polling: 500 },
      )
      await seek(page, SEEK_US)
      const probe = await waitForTier(page, layerId, 'sw', 'native-sw:')
      expect(probe.sourceKind).toBe('sw')
      expect(probe.builtFromKey!.startsWith('native-sw:')).toBe(true)
    } finally {
      await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      await app.close()
    }
  })

  // Cell 3 — pinned webcodecs skips native tiers entirely.
  // `resolveEngineTier`'s 'webcodecs' order is just [webcodecs-original,
  // proxy] — native-sw is never even considered. ProRes is WebCodecs-blind on
  // every machine (codec_is_prores), so tier 2 never becomes usable; the
  // resolver falls straight to tier 4 once the backend's quick-proxy job (the
  // SAME background job Cell 2 relies on for its native-sw route — the
  // backend routing decision is engine-setting-agnostic) actually lands.
  test('pinned webcodecs: ProRes is not WebCodecs-decodable, so tier 2 fails through to proxy (tier 4)', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    let toggledOn = false
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'prores-webcodecs-' + Date.now(), canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'webcodecs' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('webcodecs')
      toggledOn = true

      await subscribeJobEvents(page)
      const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: PRORES_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      // Tier 4 needs a real decode target (`proxyPreviewPath`), so unlike
      // Cell 2 this must wait for the quick proxy FILE, not just the route
      // decision — the route can commit `native-sw` well before the
      // background ffmpeg job actually finishes encoding.
      await waitForJobComplete(page, mediaId, 'quick_proxy')
      await seek(page, SEEK_US)
      const probe = await waitForTier(page, layerId, 'webcodecs', 'proxy:')
      expect(probe.sourceKind).toBe('webcodecs')
      expect(probe.builtFromKey!.startsWith('proxy:')).toBe(true)
    } finally {
      if (toggledOn) {
        await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      }
      await app.close()
    }
  })

  // Cell 4 — probe-driven tier 3 (Task 14/D3): pinned `native` puts native-sw
  // AHEAD of webcodecs-original in the resolver's order (native-hw → native-sw
  // → webcodecs-original → proxy). This must use an HW-INCAPABLE, non-blind-
  // spot format: with tier 1 live (D4/Task 17), any HW-decodable codec (H.264,
  // HEVC on this GPU) now wins native-hw under `native` and never reaches tier
  // 3. AV1 fits — it is NOT on the static blind-spot list (so the route seed
  // leaves `nativeSw` "untested", forcing the PROBE, not the seed, to light the
  // lane — unlike Cell 2's ProRes), and the app's d3d11va HW probe returns
  // ok:false for AV1 (so tier 1 is knocked out). PixiPreview's first pass finds
  // nothing "ok", kicks BOTH the HW probe (→ fail) and the SW probe (→ ok via
  // dav1d); the resulting `setSwLane` + refreshSources nudge lets native-sw win
  // the next resolution — proving tier 3 accepts a probe-passed format BEYOND
  // the hardcoded blind-spot families Cell 2 covers.
  test('pinned native + AV1: probe-driven native-sw (tier 3) — HW-incapable, non-blind-spot format', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    let toggledOn = false
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'av1-native-' + Date.now(), canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'native' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('native')
      toggledOn = true

      const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: AV1_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      await seek(page, SEEK_US)
      const probe = await waitForTier(page, layerId, 'sw', 'native-sw:')
      expect(probe.sourceKind).toBe('sw')
      expect(probe.builtFromKey!.startsWith('native-sw:')).toBe(true)
    } finally {
      if (toggledOn) {
        await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      }
      await app.close()
    }
  })

  // Cell 5 — pinned native + H.264: probe-gated tier 1 (native-hw). This is the
  // FIRST production-path exercise of NativeGpuSourceHandle (previously bench-
  // only / E2E-gated in the pool — Task 17 removed that gate). 8-bit H.264
  // yuv420p IS d3d11va-decodable, so the GPU capability probe (decodeCap:probeHw)
  // passes on a real GPU box; PixiPreview's HW-probe kick lights tier 1's lane
  // "ok", and the resolver routes forceStrategy:'native' → NativeGpuSourceHandle
  // (sourceKind 'native-gpu', builtFromKey 'native-hw:…') through the no-flash
  // swap. LOCAL GPU box only — guarded by WEFTCUT_DECODE_E2E like the whole
  // describe (needs both the native-decode component AND a GPU whose driver
  // d3d11va-decodes H.264).
  test('pinned native + H.264: probe-gated native-gpu (tier 1) — the production HW path', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    let toggledOn = false
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'h264-native-' + Date.now(), canvas: CANVAS })
      const after = (await invokeCmd(page, 'app_settings_set', {
        patch: { decode_engine: 'native' },
      })) as { decode_engine: string }
      expect(after.decode_engine).toBe('native')
      toggledOn = true

      const { layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: H264_FIXTURE })
      expect(kind).toBe('Video')

      await waitForPreviewBridge(page)
      await seek(page, SEEK_US)
      const probe = await waitForTier(page, layerId, 'native-gpu', 'native-hw:')
      expect(probe.sourceKind).toBe('native-gpu')
      expect(probe.builtFromKey!.startsWith('native-hw:')).toBe(true)
    } finally {
      if (toggledOn) {
        await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'auto' } }).catch(() => {})
      }
      await app.close()
    }
  })
})
