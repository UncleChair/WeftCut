import { test, expect, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, waitForHook } from './helpers/driver'

// Frame-CONTENT-order regression guard for the native-hw (d3d11va GPU) preview
// lane. The Phase-D manual HW smoke found that native-hw presents B-frame
// content OUT OF ORDER during forward playback (jumps/repeats/reverses) even
// though the ring self-sorts by PTS — i.e. the bitmap paired with a PTS carried
// a DIFFERENT frame's pixels (the shared-texture slot read/ack coherence race).
// The decode-bench never caught it because throughput/seek measure fps + frame
// COUNT, never CONTENT.
//
// This drives `decodeBenchOrderCheck` against an index-encoded clip (each
// presentation frame N carries a 12-stripe binary barcode of N) through the
// REAL renderer native-hw path (private SourceDecoderPool, forceStrategy
// 'native' → NativeGpuSourceHandle → shared-texture import → createImageBitmap),
// and asserts every delivered bitmap's barcode matches its pts-derived index.
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

interface OrderCheckMismatch { ptsUs: number; expectedIdx: number; decodedIdx: number }
interface OrderCheckResult {
  strategy: string
  poolSize: number | null
  checked: number
  missing: number
  mismatches: OrderCheckMismatch[]
  error?: string
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
  const head = `strategy=${r.strategy} pool=${r.poolSize} checked=${r.checked} missing=${r.missing} mismatches=${r.mismatches.length}${r.error ? ` error=${r.error}` : ''}`
  const ex = r.mismatches
    .slice(0, 12)
    .map((m) => `  pts=${m.ptsUs} expected=${m.expectedIdx} decoded=${m.decodedIdx} (Δ=${m.decodedIdx - m.expectedIdx})`)
    .join('\n')
  return ex ? `${head}\n${ex}` : head
}

test.describe('native-hw preview presents frames in order (Electron)', () => {
  test.skip(
    process.env.WEFTCUT_DECODE_E2E !== '1',
    'native-hw order guard is local-only (needs the native-decode component + a GPU that d3d11va-decodes HEVC); set WEFTCUT_DECODE_E2E=1 to run',
  )
  test.skip(!existsSync(CLIP), `index-encoded fixture not found at ${CLIP} (generate via e2e/scripts/gen-order-fixture.mjs)`)

  // Swept across pool sizes because the reorder corrupted frame N with the
  // frame POOL_SIZE ahead (decoded = expected + pool_size): a fix that only held
  // at the production default (3) would be a coincidence, and a future pool
  // change would silently reopen the hole. pool=1 is the tightest race (every
  // slot read contends the very next frame).
  for (const poolSize of [1, 3, 5]) {
    test(`native-hw (pool=${poolSize}): every delivered frame's pixels match its PTS (no reorder)`, async () => {
      test.setTimeout(180_000)
      const { app, page } = await launchApp()
      try {
        const r = await runOrderCheck(page, 'native', poolSize)
        // eslint-disable-next-line no-console
        console.log(`[preview-gpu-order] native pool=${poolSize} ->\n` + report(r))
        expect(r.error, `order check errored: ${r.error}`).toBeUndefined()
        // The clip has 300 frames; a functioning lane reads essentially all of
        // them. A near-empty run means decode failed, not that order is "fine".
        expect(r.checked, 'too few frames checked — native-hw decode did not run').toBeGreaterThan(200)
        expect(
          r.mismatches.length,
          `native-hw (pool=${poolSize}) presented ${r.mismatches.length} frame(s) whose pixels did not match their PTS (reorder):\n${report(r)}`,
        ).toBe(0)
      } finally {
        await app.close()
      }
    })
  }

  // Control: the native SOFTWARE lane (SwSourceHandle) shares the ring + the
  // barcode reader but NOT the shared-texture slot pool. It must pass — proving
  // any native-hw failure above is the GPU slot path, not a harness/clip/reader
  // artifact.
  test('native-sw (control): presents the same clip in order', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      const r = await runOrderCheck(page, 'sw')
      // eslint-disable-next-line no-console
      console.log('[preview-gpu-order] sw (control) ->\n' + report(r))
      expect(r.error, `order check errored: ${r.error}`).toBeUndefined()
      expect(r.checked, 'too few frames checked — native-sw decode did not run').toBeGreaterThan(200)
      expect(
        r.mismatches.length,
        `native-sw (control) reordered — harness/clip/reader is suspect, not the GPU path:\n${report(r)}`,
      ).toBe(0)
    } finally {
      await app.close()
    }
  })
})
