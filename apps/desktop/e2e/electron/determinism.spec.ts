// e2e gate: determinism capture harness.
//
// Captures fixed frames from built-in motifs (positive cases) and a synthetic
// "jitter" motif that uses Math.random (negative control) into
// determinism-artifacts/<platform>/ as PNGs.
//
// This spec runs locally (Windows) to produce the per-OS artifact set; CI runs
// it on Linux/macOS and then runs compare-determinism.mjs across the dirs.
//
// SOFTWARE RENDERING NOTE:
// Forcing --disable-gpu --use-gl=swiftshader --in-process-gpu causes the
// offscreen BrowserWindow CDP capture to hang on Windows 11 (test times out at
// 120s; motif-capture without those flags passes in ~1s). Root cause: the
// offscreen BrowserWindow + CDP path deadlocks under swiftshader on Windows.
// This spec therefore runs without forced-swiftshader; the cross-OS comparison
// must accept that each OS uses its own GPU path.
//
// Real built-in motif IDs (from src/renderer/render/motifs/builtin/*/manifest.json):
//   countdown     480×480   t in [0,5]
//   lower-third   1280×320  t in [0,5]

import { test } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launchApp } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Positive cases — built-in motifs only. Dimensions match each motif's declared size.
const POSITIVE = [
  { id: 'countdown',   t: 2.0, w: 480,  h: 480 },
  { id: 'lower-third', t: 1.0, w: 1280, h: 320 },
]

test('capture fixed motif frames for cross-OS comparison @serial', async () => {
  test.setTimeout(120_000)

  const outDir = path.join(__dirname, '../../determinism-artifacts', process.platform)
  fs.mkdirSync(outDir, { recursive: true })

  // NOTE: swiftshader (--disable-gpu --use-gl=swiftshader --in-process-gpu)
  // hangs the offscreen CDP capture on Windows 11 — see file header for details.
  // Running without forced-GPU-disable on Windows; Task 8 / CI must address this.
  // launchApp() waits for domcontentloaded (after main.tsx runs) so the motif
  // runtime is registered before we issue any capture calls.
  const { app, page } = await launchApp()

  // Retry-until-registered guard: on slow CI the motif runtime may not be
  // registered immediately after domcontentloaded.  We retry up to ~10 s.
  const capWithRetry = async (motifId: string, tSec: number, w: number, h: number, propsJson = '{}'): Promise<string> => {
    const MAX = 40
    for (let i = 0; i < MAX; i++) {
      try {
        const result = (await page.evaluate(
          ([id, t, props, width, height]) =>
            (window as any).api.backend.invoke('motif_capture_frame', {
              motifId: id,
              tSec: t,
              propsJson: props,
              width,
              height,
              settleRafs: 3,
              contentHash: 'det',
            }) as Promise<string>,
          [motifId, tSec, propsJson, w, h] as const,
        )) as string
        return result
      } catch (e: any) {
        if (typeof e?.message === 'string' && e.message.includes('runtime not registered') && i < MAX - 1) {
          await new Promise((r) => setTimeout(r, 250))
          continue
        }
        throw e
      }
    }
    throw new Error('motif runtime never registered after 10 s')
  }

  try {
    const cap = async (motifId: string, tSec: number, w: number, h: number, propsJson = '{}') =>
      (await page.evaluate(
        ([id, t, props, width, height]) =>
          (window as any).api.backend.invoke('motif_capture_frame', {
            motifId: id,
            tSec: t,
            propsJson: props,
            width,
            height,
            settleRafs: 3,
            contentHash: 'det',
          }) as Promise<string>,
        [motifId, tSec, propsJson, w, h] as const,
      )) as string

    // ── Positive cases ─────────────────────────────────────────────────────────
    // First capture uses capWithRetry to absorb any runtime-registration delay.
    let firstPositive = true
    for (const c of POSITIVE) {
      const b64 = firstPositive
        ? await capWithRetry(c.id, c.t, c.w, c.h)
        : await cap(c.id, c.t, c.w, c.h)
      firstPositive = false
      if (!b64 || b64.length < 1000) {
        throw new Error(`motif_capture_frame returned an empty/short result for ${c.id}: length=${b64?.length}`)
      }
      fs.writeFileSync(path.join(outDir, `${c.id}.png`), Buffer.from(b64, 'base64'))
      console.log(`[det] captured ${c.id}.png (b64 len=${b64.length})`)
    }

    // ── Negative control: jitter motif ─────────────────────────────────────────
    // Uses Math.random to fill the entire canvas with random noise so two captures
    // always diverge substantially — validates the gate has teeth.
    // The motif HTML uses window.__motifRender (the raw function signature the
    // capture host calls directly, not the motif.define() SDK path which is for
    // user-authored motifs with the full runtime).
    // Checkerboard of random colors using CSS custom properties — each capture
    // produces a different pattern because each cell gets a fresh Math.random()
    // color. Two captures differ in ALL cells → global SSIM well below 0.98.
    // Uses motif.define() so the runtime's native-RAF settle runs after frame().
    const jitterHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;overflow:hidden}
#board{width:480px;height:480px;display:flex;flex-wrap:wrap}
.cell{width:60px;height:60px;flex-shrink:0}
</style></head><body>
<div id="board">${Array.from({ length: 64 }, (_, i) => `<div class="cell" id="c${i}"></div>`).join('')}</div>
<script>
motif.define({
  frame(t, ctx) {
    for(var i=0;i<64;i++){
      var r=Math.random()*255|0,g=Math.random()*255|0,b=Math.random()*255|0;
      document.getElementById('c'+i).style.background='rgb('+r+','+g+','+b+')';
    }
  }
});
<\/script></body></html>`

    // write_motif_draft — napi expects { args: { manifest, html } }
    const manifest = {
      id: 'det-jitter',
      name: 'Det Jitter',
      version: 1,
      size: [480, 480],
      default_duration_s: 2,
      props_schema: {},
    }
    const draftId = (await page.evaluate(
      ([ch, a]) => (window as any).api.backend.invoke(ch, a),
      ['write_motif_draft', { args: { manifest, html: jitterHtml } }] as const,
    )) as string
    console.log('[det] jitter draft id:', draftId)

    // install_motif — napi expects { args: { draft_id, mode: { kind: "new" } } }
    const publishedId = (await page.evaluate(
      ([ch, a]) => (window as any).api.backend.invoke(ch, a),
      ['install_motif', { args: { draft_id: draftId, mode: { kind: 'new' } } }] as const,
    )) as string
    console.log('[det] jitter published id:', publishedId)

    const jb64 = await cap(publishedId, 0.5, 480, 480)
    if (!jb64 || jb64.length < 1000) {
      throw new Error(`motif_capture_frame returned an empty/short result for jitter: length=${jb64?.length}`)
    }
    fs.writeFileSync(path.join(outDir, 'NEG-det-jitter.png'), Buffer.from(jb64, 'base64'))
    console.log(`[det] captured NEG-det-jitter.png (b64 len=${jb64.length})`)

    // Clean up jitter motif to avoid accumulation across repeated local/CI runs.
    try {
      await page.evaluate(
        ([ch, a]) => (window as any).api.backend.invoke(ch, a),
        ['delete_motif', { id: publishedId }] as const,
      )
      console.log('[det] jitter motif deleted:', publishedId)
    } catch (e) {
      console.warn('[det] delete_motif failed (non-fatal):', e)
    }

    // Confirm all expected files exist.
    const expected = [...POSITIVE.map((c) => `${c.id}.png`), 'NEG-det-jitter.png']
    for (const name of expected) {
      const p = path.join(outDir, name)
      if (!fs.existsSync(p)) throw new Error(`artifact missing: ${p}`)
    }
    console.log('[det] all artifacts written to', outDir)
  } finally {
    await app.close()
  }
})
