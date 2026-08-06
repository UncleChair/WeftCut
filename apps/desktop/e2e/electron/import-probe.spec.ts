import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, waitForHook } from './helpers/driver'

// Investigation for GitHub issue #7 boundary #1: a HARDWARE-decoded (GPU-backed)
// `VideoFrame` drawn into a 2D canvas is a silent no-op on Linux/NVIDIA-GL, so
// the WebCodecs export lane emits black frames (worked around today by an
// allowlist-gated `preferSoftware` — `hwExportDecodeAllowed` — at
// exportWorker.ts). Web research points at the *2D-canvas* GL import being the
// broken path, while WebGL `texImage2D` and `createImageBitmap` are Chromium's
// supported GPU-import paths (the preview lane already uses createImageBitmap
// and is HW-verified on this host).
//
// This spec drives `window.__weftcutTest.importProbe`, which decodes the clip's
// first frame under prefer-hardware AND prefer-software and, for each, imports
// the raw frame four ways (2D drawImage / createImageBitmap / WebGL texImage2D /
// copyTo), reading pixels back as mean luma. It runs the probe on the renderer
// MAIN THREAD and in a dedicated WORKER (the export bug's real context) so we
// can localise a silently-black cell.
//
// Reads out a {context}×{hw,sw}×{method} luma matrix. The hard assertion is only
// the CONTROL (software decode must import faithfully everywhere — else the probe
// or media is broken); the hardware behaviour is logged as the finding and a
// human-readable verdict, so this stays a green, reusable diagnostic regardless
// of what the platform does.
//
// Requires a VITE_WEFTCUT_E2E=1 build (the __weftcutTest hook surface).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')
const SOURCE = path.resolve(MEDIA_DIR, 'test_1080p_30fps.mp4')

interface MethodResult { meanLuma: number; litPct: number; error: string | null }
interface DecodeProbeResult {
  hwAccel: string
  isConfigSupported: boolean
  frameFormat: string | null
  drawImage: MethodResult
  createImageBitmap: MethodResult
  texImage2D: MethodResult
  copyTo: MethodResult
  error: string | null
}
interface BothModesResult { hardware: DecodeProbeResult; software: DecodeProbeResult }
interface ImportProbeResult { main: BothModesResult; worker: BothModesResult }

/// A method reads as "black" when its mean luma is essentially zero.
const BLACK_LUMA = 2
/// The control clip is a natural-content 1080p video; a faithful import reads
/// well above this.
const LIT_LUMA = 8

function fmtMethod(m: MethodResult): string {
  if (m.error) return `ERR(${m.error.slice(0, 40)})`
  const tag = m.meanLuma < BLACK_LUMA ? 'BLACK' : 'lit  '
  return `${tag} luma=${m.meanLuma.toFixed(1).padStart(5)} lit%=${m.litPct.toFixed(0).padStart(3)}`
}

function printDecode(ctx: string, mode: string, d: DecodeProbeResult): void {
  if (d.error) {
    // eslint-disable-next-line no-console
    console.log(`  [${ctx}/${mode}] DECODE ERROR: ${d.error}`)
    return
  }
  // eslint-disable-next-line no-console
  console.log(
    `  [${ctx}/${mode}] cfgSupported=${d.isConfigSupported} fmt=${d.frameFormat}\n` +
      `      drawImage       : ${fmtMethod(d.drawImage)}\n` +
      `      createImageBitmap: ${fmtMethod(d.createImageBitmap)}\n` +
      `      texImage2D      : ${fmtMethod(d.texImage2D)}\n` +
      `      copyTo          : ${fmtMethod(d.copyTo)}`,
  )
}

test('issue#7 #1: HW VideoFrame import path comparison (drawImage/createImageBitmap/texImage2D) @serial', async () => {
  test.skip(!existsSync(SOURCE), `source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`)
  test.setTimeout(180_000)

  const { app, page } = await launchApp()
  const consoleLines: string[] = []
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e)}`))

  try {
    await waitForHook(page, 'importProbe')
    const r = (await page.evaluate(
      (sourcePath) =>
        (window as unknown as {
          __weftcutTest: { importProbe(a: { sourcePath: string }): Promise<ImportProbeResult> }
        }).__weftcutTest.importProbe({ sourcePath }),
      SOURCE,
    )) as ImportProbeResult

    // eslint-disable-next-line no-console
    console.log('\n===== issue#7 boundary#1 — VideoFrame import matrix =====')
    printDecode('main', 'HW', r.main.hardware)
    printDecode('main', 'SW', r.main.software)
    printDecode('worker', 'HW', r.worker.hardware)
    printDecode('worker', 'SW', r.worker.software)

    // ── Verdict: for each context, is HW drawImage black while an alternative
    //    import path stays lit? That is the actionable finding (a Linux HW
    //    export unlock via the surviving path). ────────────────────────────────
    const verdict = (ctx: string, b: BothModesResult): string => {
      const hw = b.hardware
      if (hw.error) return `${ctx}: HW decode errored (${hw.error})`
      const di = hw.drawImage
      const black = (m: MethodResult) => !m.error && m.meanLuma < BLACK_LUMA
      const lit = (m: MethodResult) => !m.error && m.meanLuma >= LIT_LUMA
      if (black(di)) {
        const survivors = [
          lit(hw.createImageBitmap) ? 'createImageBitmap' : null,
          lit(hw.texImage2D) ? 'texImage2D' : null,
          lit(hw.copyTo) ? 'copyTo' : null,
        ].filter(Boolean)
        return survivors.length
          ? `${ctx}: HW drawImage BLACK — but ${survivors.join(' & ')} returned real pixels → Linux HW export could route through it`
          : `${ctx}: HW drawImage BLACK and every alternative also black → no import path survives HW decode`
      }
      return `${ctx}: HW drawImage lit (meanLuma=${di.meanLuma.toFixed(1)}) — boundary #1 did not reproduce here (HW may have fallen back to SW; cfgSupported=${hw.isConfigSupported})`
    }
    // eslint-disable-next-line no-console
    console.log('\n----- verdict -----')
    // eslint-disable-next-line no-console
    console.log('  ' + verdict('main', r.main))
    // eslint-disable-next-line no-console
    console.log('  ' + verdict('worker', r.worker))
    // eslint-disable-next-line no-console
    console.log('===========================================================\n')

    // ── CONTROL: software decode must import faithfully in both contexts via at
    //    least the 2D drawImage path (the baseline the whole pipeline relies on).
    //    If this fails, the probe or the media is broken, not the platform. ─────
    for (const [ctx, both] of [['main', r.main], ['worker', r.worker]] as const) {
      expect(both.software.error, `${ctx} SW decode errored`).toBeNull()
      expect(
        both.software.drawImage.meanLuma,
        `${ctx} SW drawImage should be a faithful (non-black) import`,
      ).toBeGreaterThan(LIT_LUMA)
    }

    const errs = consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
    // eslint-disable-next-line no-console
    if (errs.length) console.log(`renderer errors during run:\n` + errs.join('\n'))
  } finally {
    await app.close()
  }
})
