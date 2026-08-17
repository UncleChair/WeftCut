import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, summary, driveExport, tmpDir } from './helpers/driver'

// Effect gates on the live compositor. Every test here is GPU-dependent, so
// all of them are local-only (mirrors motif-export.spec.ts): the Pixi
// BlurFilter is a no-op under the Linux headless software-GL runner
// (xvfb/llvmpipe), so `blur` reads back byte-identical to `sharp`, and the
// export legs need WebCodecs H.264 hardware encode. Each `test.skip` below
// carries only what is extra for that test.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/// Solid colour patches on a 384-px grid — hard RGB edges, which is what a
/// sharpen kernel has anything to do to. Honours WEFTCUT_TEST_MEDIA like the
/// conformance specs, so a machine that keeps its fixtures elsewhere still runs.
const CHART = path.join(
  process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media'),
  'color_chart.png',
)

interface McpInfo {
  url: string
  bearer_token: string
}

async function connectMcp(info: McpInfo): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  })
  const client = new Client({ name: 'effects-smoke', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

/// Find a layer in the project summary by id and return its effects array.
function effectsOf(s: { tracks: Array<{ layers: Array<{ id: string; effects?: unknown[] }> }> }, layerId: string): unknown[] {
  for (const t of s.tracks) {
    for (const l of t.layers) {
      if (l.id === layerId) return l.effects ?? []
    }
  }
  throw new Error(`layer ${layerId} not in summary`)
}

interface Sample {
  nonTransparent: number
  maxA: number
  r: number
  g: number
  b: number
  a: number
}

/// Seek to tUs, force a composite, and read whole-frame stats off the live canvas.
async function sampleAt(page: import('@playwright/test').Page, tUs: number, x: number, y: number): Promise<Sample> {
  // weftcutSeekUs throws until the PixiPreview bridge registers; retry briefly.
  const deadline = Date.now() + 15_000
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await page.evaluate(
      async ({ t, px, py }) => {
        try {
          const w = window as any
          if (typeof w.__weftcutTest?.weftcutSeekUs !== 'function') return { ok: false }
          w.__weftcutTest.weftcutSeekUs(t)
          const s = await w.__weftcutTest.weftcutSampleComposite(px, py)
          return { ok: true, s }
        } catch {
          return { ok: false }
        }
      },
      { t: tUs, px: x, py: y },
    )
    if ((r as any).ok) return (r as any).s as Sample
    if (Date.now() > deadline) throw new Error('weftcutSampleComposite never became ready')
    await page.waitForTimeout(300)
  }
}

test('effects: add a blur via MCP renders + persists, undo removes it', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'blur pixel-diff + export need a real GPU not on headless CI; verified locally',
  )
  test.setTimeout(120_000)
  const { app, page } = await launchApp()

  const parent = tmpDir('weftcut-effects-smoke-')
  await newProject(page, {
    parentFolder: parent,
    name: 'effects-smoke',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  // A fresh track + a text layer (edges → blur is visible as alpha spread).
  const trackId = await invokeCmd<string>(page, 'add_track', {})
  const layerId = await invokeCmd<string>(page, 'add_text_layer', {
    trackId,
    content: 'BLUR SMOKE TEST',
    tStartUs: 0,
    durationUs: 2_000_000,
  })
  expect(typeof layerId).toBe('string')

  // WARM UP FIRST (no effect yet): poll until the text has composited so the
  // sharp baseline is measured warm — controls for the cold-start confound
  // (a first sample can read 0 before the glyph texture is ready).
  let sharpSample: Sample | null = null
  {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const s0 = await sampleAt(page, 500_000, 320, 180)
      if (s0.nonTransparent > 100) {
        sharpSample = s0
        break
      }
      await page.waitForTimeout(400)
    }
  }
  if (!sharpSample) throw new Error('text layer never composited (warmup failed)')
  console.log('EFFECTS_SMOKE sharp(baseline, warm, no effect) =', JSON.stringify(sharpSample))

  // Add a blur effect through the REAL MCP server (the path an external agent uses).
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as McpInfo
  const mcp = await connectMcp(info)
  const tools = (await mcp.listTools()).tools.map((t) => t.name)
  expect(tools).toContain('add_effect')
  const addRes = await mcp.callTool({ name: 'add_effect', arguments: { layer_id: layerId, kind: 'blur' } })
  const effectId = structuredClone(addRes.content)[0].text as string
  expect(effectId.length).toBeGreaterThan(0)

  // The effect persisted into the project view the renderer reads.
  let s = await summary(page)
  let fx = effectsOf(s as any, layerId) as Array<{ kind: string }>
  expect(fx).toHaveLength(1)
  expect(fx[0]!.kind).toBe('blur')

  // Sample the blurred render (already warm). Poll a few rounds so the
  // project:changed → setProject event has applied the new filter chain.
  await page.waitForTimeout(800)
  let blurSample = await sampleAt(page, 500_000, 320, 180)
  {
    const deadline = Date.now() + 6_000
    while (blurSample.nonTransparent === sharpSample.nonTransparent && Date.now() < deadline) {
      await page.waitForTimeout(400)
      blurSample = await sampleAt(page, 500_000, 320, 180)
    }
  }
  console.log('EFFECTS_SMOKE blur(warm, effect on) =', JSON.stringify(blurSample))

  // EXPORT with the blur ON — the blur must survive into the export Worker's
  // own composite, not just the preview. driveExport throwing is logged, not
  // fatal: nothing here inspects the encoded file.
  const exportOut = path.join(parent, 'export-blur.mp4')
  try {
    const exp = await driveExport(page, { outputAbsPath: exportOut }, { hook: 'exportTimeline', timeout: 150_000 })
    console.log('EFFECTS_SMOKE export =', JSON.stringify(exp), '->', exportOut)
  } catch (e) {
    console.log('EFFECTS_SMOKE export ERR =', String(e), '->', exportOut)
  }

  // Inspection pause: hold the window open (blur ON, seeked to the text frame)
  // so a human can eyeball whether the preview actually shows blurred text or a
  // black/empty frame. Gated so the normal automated run isn't slowed.
  if (process.env.WEFTCUT_SMOKE_PAUSE) {
    await page.evaluate(() => (window as any).__weftcutTest.weftcutSeekUs(500_000))
    console.log('EFFECTS_SMOKE PAUSED — blur is ON, look at the preview canvas. Ctrl-C to quit.')
    await page.waitForTimeout(600_000)
  }

  // Undo removes the effect from state.
  await mcp.callTool({ name: 'undo', arguments: {} })
  await page.waitForTimeout(800)
  s = await summary(page)
  fx = effectsOf(s as any, layerId) as Array<{ kind: string }>
  expect(fx).toHaveLength(0)
  const afterUndo = await sampleAt(page, 500_000, 320, 180)
  console.log('EFFECTS_SMOKE afterUndo =', JSON.stringify(afterUndo))

  // The blur measurably changes the rendered composite vs the sharp baseline
  // (blur spreads the text's alpha → the non-transparent pixel count changes).
  expect(blurSample.nonTransparent).not.toBe(sharpSample.nonTransparent)
  expect(blurSample.nonTransparent).toBeGreaterThan(0)

  await mcp.close()
  await app.close()
})

test('effects: blur on a Motif layer renders + exports + undo', async () => {
  // Extra beyond the file-level GPU requirement: the motif capture can exceed
  // the 5s CDP budget on slow CI runners.
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'blur pixel-diff + motif export need a real GPU not on headless CI; verified locally',
  )
  test.setTimeout(180_000)
  const { app, page } = await launchApp()

  const parent = tmpDir('weftcut-motif-effects-')
  await newProject(page, {
    parentFolder: parent,
    name: 'motif-effects',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  // add_motif with no trackId spawns its own Overlay track and returns the
  // layer id. The built-in "countdown" motif is 480x480 / 5s, so it leaves
  // transparent margins on a 640x360 canvas — a blur measurably spreads its
  // alpha footprint. Sample at 0.5s, well inside [0, 5s].
  const layerId = await invokeCmd<string>(page, 'add_motif', {
    motifId: 'countdown',
    tStartUs: 0,
  })
  expect(typeof layerId).toBe('string')

  // WARM UP until the REAL captured frame has landed AND settled. Motif frame
  // capture is async (CDP); the first sample after a seek can show the cold
  // placeholder, which would poison the baseline. Require two consecutive
  // equal non-transparent readings above threshold before trusting it.
  let sharpSample: Sample | null = null
  {
    const deadline = Date.now() + 60_000
    let prev = -1
    while (Date.now() < deadline) {
      const s0 = await sampleAt(page, 500_000, 320, 180)
      if (s0.nonTransparent > 100 && s0.nonTransparent === prev) {
        sharpSample = s0
        break
      }
      prev = s0.nonTransparent
      await page.waitForTimeout(500)
    }
  }
  if (!sharpSample) throw new Error('motif layer never composited+settled (warmup failed)')
  console.log('MOTIF_EFFECTS sharp(baseline, warm, no effect) =', JSON.stringify(sharpSample))

  // Add a blur through the REAL MCP server (the path an external agent uses).
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as McpInfo
  const mcp = await connectMcp(info)
  const tools = (await mcp.listTools()).tools.map((t) => t.name)
  expect(tools).toContain('add_effect')
  const addRes = await mcp.callTool({ name: 'add_effect', arguments: { layer_id: layerId, kind: 'blur' } })
  const effectId = structuredClone(addRes.content)[0].text as string
  expect(effectId.length).toBeGreaterThan(0)

  // The effect persisted into the project view the renderer reads.
  let s = await summary(page)
  let fx = effectsOf(s as any, layerId) as Array<{ kind: string }>
  expect(fx).toHaveLength(1)
  expect(fx[0]!.kind).toBe('blur')

  // Sample the blurred render. Poll so the project:changed -> setProject event
  // applies the new filter chain to the Motif sprite.
  await page.waitForTimeout(800)
  let blurSample = await sampleAt(page, 500_000, 320, 180)
  {
    const deadline = Date.now() + 8_000
    while (blurSample.nonTransparent === sharpSample.nonTransparent && Date.now() < deadline) {
      await page.waitForTimeout(400)
      blurSample = await sampleAt(page, 500_000, 320, 180)
    }
  }
  console.log('MOTIF_EFFECTS blur(warm, effect on) =', JSON.stringify(blurSample))

  // EXPORT with the blur ON (8-bit). The export Worker binds baked motif frames
  // to the same Pixi Sprite, so the filter chain has to reach them there too.
  // driveExport throwing is logged, not asserted, mirroring the sibling test.
  const exportOut = path.join(parent, 'export-motif-blur.mp4')
  try {
    const exp = await driveExport(page, { outputAbsPath: exportOut }, { hook: 'exportTimeline', timeout: 150_000 })
    console.log('MOTIF_EFFECTS export =', JSON.stringify(exp), '->', exportOut)
  } catch (e) {
    console.log('MOTIF_EFFECTS export ERR =', String(e), '->', exportOut)
  }

  // Undo removes the effect from state.
  await mcp.callTool({ name: 'undo', arguments: {} })
  await page.waitForTimeout(800)
  s = await summary(page)
  fx = effectsOf(s as any, layerId) as Array<{ kind: string }>
  expect(fx).toHaveLength(0)

  // The blur measurably changes the rendered composite vs the sharp baseline
  // (it spreads the motif's alpha footprint into the transparent margins).
  expect(blurSample.nonTransparent).not.toBe(sharpSample.nonTransparent)
  expect(blurSample.nonTransparent).toBeGreaterThan(0)

  await mcp.close()
  await app.close()
})

test('effects UI: add/edit/reorder/remove a blur from the inspector panel', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'blur pixel-diff needs a real GPU not on headless CI; verified locally',
  )
  test.setTimeout(120_000)
  const { app, page } = await launchApp()

  const parent = tmpDir('weftcut-effects-ui-')
  await newProject(page, {
    parentFolder: parent,
    name: 'effects-ui',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  const trackId = await invokeCmd<string>(page, 'add_track', {})
  const layerId = await invokeCmd<string>(page, 'add_text_layer', {
    trackId,
    content: 'BLUR UI TEST',
    tStartUs: 0,
    durationUs: 2_000_000,
  })

  // Warm the sharp baseline (text composited, no effect yet).
  let sharp: Sample | null = null
  {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const s0 = await sampleAt(page, 500_000, 320, 180)
      if (s0.nonTransparent > 100) { sharp = s0; break }
      await page.waitForTimeout(400)
    }
  }
  if (!sharp) throw new Error('text never composited (warmup failed)')

  // Select the layer so the inspector renders its EffectsSection.
  await page.evaluate((id) => (window as any).__weftcutTest.revealLayer({ layerId: id }), layerId)
  // Bring the Effect tab forward: the pristine baseline docks it inactive behind
  // Attribute, which leaves effect-add rendered but hidden.
  await page.locator('.weft-dock-tab-label', { hasText: 'Effect' }).click()
  // Wait for the panel to render before clicking Add (guards the selection→render race).
  await page.getByTestId('effect-add').waitFor({ state: 'visible' })

  // Add a blur via the panel picker: the trigger opens a searchable, grouped
  // popup; the row carries the kind in its testid.
  await page.getByTestId('effect-add').click()
  await page.getByTestId('effect-pick-blur').click()
  await expect.poll(async () => (effectsOf((await summary(page)) as any, layerId) as Array<{ kind: string }>).length).toBe(1)
  let fx = effectsOf((await summary(page)) as any, layerId) as Array<{ kind: string; id: string; enabled: boolean; params: any }>
  expect(fx[0]!.kind).toBe('blur')
  const effectId = fx[0]!.id

  // Reorder via the panel: add a second blur, move the first down, confirm the
  // summary order swapped, then drop the extra so the rest of the test operates
  // on the original effect.
  await page.getByTestId('effect-add').click()
  await page.getByTestId('effect-pick-blur').click()
  await expect.poll(async () => (effectsOf((await summary(page)) as any, layerId) as unknown[]).length).toBe(2)
  const order = effectsOf((await summary(page)) as any, layerId) as Array<{ id: string }>
  expect(order[0]!.id).toBe(effectId) // original blur is first
  const secondId = order[1]!.id
  // Move/reset/remove live behind the card's ⋯ overflow menu, so each needs
  // its trigger opened first.
  await page.getByTestId('effect-menu-0').click()
  await page.getByTestId('effect-down-0').click()
  await expect.poll(async () => {
    const f = effectsOf((await summary(page)) as any, layerId) as Array<{ id: string }>
    return f[0]?.id
  }).toBe(secondId) // moving row 0 down puts the second effect first
  // Drop the extra (now at row 0); the original effectId returns to row 0.
  await page.getByTestId('effect-menu-0').click()
  await page.getByTestId('effect-remove-0').click()
  await expect.poll(async () => (effectsOf((await summary(page)) as any, layerId) as unknown[]).length).toBe(1)
  await expect.poll(async () => {
    const f = effectsOf((await summary(page)) as any, layerId) as Array<{ id: string }>
    return f[0]?.id
  }).toBe(effectId) // back to a single original blur at row 0

  // Edit strength through the param field (commits on blur → nested track key).
  // The param wrapper contains two <input>s: the visible text input and a hidden type=number;
  // target the first (visible) one explicitly.
  // Base UI NumberField treats Enter as a navigation key (no commit); blur() fires onBlur
  // which triggers onValueCommitted synchronously.
  const strength = page.getByTestId(`effect-param-${effectId}-strength`).locator('input').first()
  await strength.click({ clickCount: 3 })
  await strength.pressSequentially('30')
  await strength.blur()
  await expect.poll(async () => {
    const f = effectsOf((await summary(page)) as any, layerId) as Array<{ params: any }>
    return f[0]?.params?.strength?.value ?? null
  }).toBe(30)

  // The blur measurably changes the composite vs the sharp baseline.
  await page.waitForTimeout(800)
  let blur = await sampleAt(page, 500_000, 320, 180)
  {
    const deadline = Date.now() + 6_000
    while (blur.nonTransparent === sharp.nonTransparent && Date.now() < deadline) {
      await page.waitForTimeout(400)
      blur = await sampleAt(page, 500_000, 320, 180)
    }
  }
  expect(blur.nonTransparent).not.toBe(sharp.nonTransparent)

  // Disable via the toggle → enabled:false in state.
  await page.getByTestId('effect-enable-0').click()
  await expect.poll(async () => {
    const f = effectsOf((await summary(page)) as any, layerId) as Array<{ enabled: boolean }>
    return f[0]?.enabled
  }).toBe(false)

  // Remove via the panel → chain empties.
  await page.getByTestId('effect-menu-0').click()
  await page.getByTestId('effect-remove-0').click()
  await expect.poll(async () => (effectsOf((await summary(page)) as any, layerId) as unknown[]).length).toBe(0)

  await app.close()
})

// A custom shader earns a live-app frame check that a data-driven descriptor
// over a stock filter does not: the parity gate builds its own renderer from the
// shader source and the registry tests never reach a GPU, so nothing else runs
// the shipped SharpenFilter — its two programs, its uniform group, the effect
// chain around it — against a real composited frame. The colour-matrix entries
// need no equivalent, which is why sharpen is the only one here.
//
// It exercises whichever backend the preview picked, which on Linux today is
// WebGL: Chromium hands `requestAdapter()` null without --enable-features=Vulkan,
// and Playwright's own --enable-features=CDPScreenshotNewSurface overrides that
// switch when passed via WEFTCUT_E2E_GL. Forcing WebGPU here would not help
// anyway — the app's frame-capture hook is broken under WebGPU on this platform
// (Pixi copies its bgra8unorm texture into an rgba8unorm canvas and Dawn rejects
// it), which is why the WGSL twin is verified by the parity gate's third
// condition instead of here.
//
// The comparison is deliberately amount-vs-amount rather than effect-vs-no-effect:
// both frames then travel the identical filter path (sprite → pool intermediate →
// filter blit) and only the uniform differs, so what it isolates is the kernel.
test('effects: sharpen rings a chart in the live preview, and amount 0 undoes it', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'frame-diffing the live preview needs a real GPU not on headless CI; verified locally',
  )
  test.skip(!existsSync(CHART), `chart fixture not found at ${CHART} (run: cd apps/desktop/e2e && npm run fixtures)`)
  test.setTimeout(120_000)
  const { app, page } = await launchApp()

  // PixiPreview logs its backend at init: 2 = WebGPU (WGSL), 1 = WebGL (GLSL).
  // Recorded rather than asserted — Pixi legitimately falls back — so the log
  // says which half of the dual source this run actually exercised.
  const backends: number[] = []
  page.on('console', (m) => {
    const hit = /application init: .*renderer=(\d+)/.exec(m.text())
    if (hit) backends.push(Number(hit[1]))
  })

  const parent = tmpDir('weftcut-sharpen-smoke-')
  await newProject(page, {
    parentFolder: parent,
    name: 'sharpen-smoke',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  const placed = await importAndPlaceMedia(page, { mediaAbsPath: CHART, tStartUs: 0 })
  expect(placed.kind).toBe('Image')
  const layerId = placed.layerId

  /// Seek to 0 and encode the composited frame. Polls until two consecutive
  /// captures agree AND `want` accepts — one capture can land mid-reconcile,
  /// and PNG equality is only meaningful once the frame has stopped moving.
  const settled = async (label: string, want?: (png: string) => boolean): Promise<string> => {
    const deadline = Date.now() + 40_000
    let prev = ''
    while (Date.now() < deadline) {
      const png = await page.evaluate(async () => {
        try {
          const w = window as any
          if (typeof w.__weftcutTest?.capturePreviewFramePng !== 'function') return ''
          w.__weftcutTest.weftcutSeekUs(0)
          return (await w.__weftcutTest.capturePreviewFramePng()) as string
        } catch {
          return ''
        }
      })
      if (png.length > 1000 && png === prev && (!want || want(png))) return png
      prev = png
      await page.waitForTimeout(400)
    }
    throw new Error(`${label}: preview frame never settled`)
  }

  const unfiltered = await settled('unfiltered')

  const effectId = await invokeCmd<string>(page, 'add_effect', { layerId, kind: 'sharpen' })
  expect(typeof effectId).toBe('string')
  const fx = effectsOf((await summary(page)) as any, layerId) as Array<{ kind: string }>
  expect(fx).toHaveLength(1)
  expect(fx[0]!.kind).toBe('sharpen')
  const setAmount = (value: number) =>
    invokeCmd(page, 'update_effect', {
      layerId,
      effectId,
      patch: { params: { amount: { mode: 'Static', value } } },
    })

  // amount 100: the chart's patch borders ring, so the frame has to move. This
  // is the assertion the test exists for.
  await setAmount(100)
  const sharpened = await settled('amount 100', (png) => png !== unfiltered)
  expect(sharpened).not.toBe(unfiltered)

  // amount 0 undoes it. Not compared against `unfiltered`: that frame skipped
  // the filter pass entirely (no pool intermediate, one resample instead of
  // two), so byte equality across the two paths is not something to assert.
  // Whether they match anyway is logged below. The pass-through's exactness is
  // gated where it can be measured — the parity gate's `sharpenZero` probe.
  await setAmount(0)
  const atZero = await settled('amount 0', (png) => png !== sharpened)
  expect(atZero).not.toBe(sharpened)

  // Back to 100: the same frame, byte for byte. The kernel is driven by the
  // parameter and nothing else — a filter that had merely gone stale, or one
  // whose uniform reached the GPU once and then stopped, fails here.
  await setAmount(100)
  const again = await settled('amount 100 again', (png) => png !== atZero)
  expect(again).toBe(sharpened)

  console.log(
    `EFFECTS_SHARPEN backends=${JSON.stringify(backends)} (2 = WebGPU/WGSL, 1 = WebGL/GLSL) ` +
      `amount0==unfiltered: ${atZero === unfiltered}`,
  )

  await app.close()
})

test('effects: chromakey keys out a green color layer; viewMatte previews the matte', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'pixel sampling needs a real GPU not on headless CI; verified locally',
  )
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const parent = tmpDir('weftcut-chromakey-smoke-')
  await newProject(page, {
    parentFolder: parent,
    name: 'chromakey-smoke',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  // Full-frame green screen + a white text layer on a second track.
  const bgTrack = await invokeCmd<string>(page, 'add_track', {})
  const bgId = await invokeCmd<string>(page, 'add_color_layer', {
    trackId: bgTrack,
    color: { r: 0, g: 255, b: 0, a: 255 },
    tStartUs: 0,
    durationUs: 2_000_000,
  })
  const fgTrack = await invokeCmd<string>(page, 'add_track', {})
  await invokeCmd<string>(page, 'add_text_layer', {
    trackId: fgTrack,
    content: 'CHROMA',
    tStartUs: 0,
    durationUs: 2_000_000,
  })

  // Baseline: bottom-right corner is green (also validates the Rgba scale —
  // if this reads black, add_color_layer took the color as 0..255).
  const before = await sampleAt(page, 500_000, 600, 340)
  expect(before.g).toBeGreaterThan(200)
  expect(before.r).toBeLessThan(60)
  expect(before.a).toBe(255)
  const FULL = 640 * 360
  expect(before.nonTransparent).toBe(FULL)

  // Key the background via real MCP.
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as McpInfo
  const mcp = await connectMcp(info)
  const addRes = await mcp.callTool({ name: 'add_effect', arguments: { layer_id: bgId, kind: 'chromakey' } })
  const effectId = structuredClone(addRes.content)[0].text as string
  expect(effectId.length).toBeGreaterThan(0)

  // Poll a few rounds so the project:changed → setProject event has applied
  // the new filter chain (mirrors the blur test above).
  let keyed = await sampleAt(page, 500_000, 600, 340)
  {
    const deadline = Date.now() + 6_000
    while (keyed.a !== 0 && Date.now() < deadline) {
      await page.waitForTimeout(400)
      keyed = await sampleAt(page, 500_000, 600, 340)
    }
  }
  expect(keyed.a).toBe(0) // green screen fully keyed at the corner
  expect(keyed.nonTransparent).toBeGreaterThan(0) // text survives
  expect(keyed.nonTransparent).toBeLessThan(FULL * 0.25)

  // viewMatte=1 → whole bg layer outputs (alpha,alpha,alpha,1): opaque black at the corner.
  await mcp.callTool({ name: 'update_effect', arguments: {
    layer_id: bgId, effect_id: effectId,
    patch: { params: { viewMatte: { mode: 'Static', value: 1 } } },
  } })
  let matte = await sampleAt(page, 500_000, 600, 340)
  {
    const deadline = Date.now() + 6_000
    while (!(matte.a === 255 && matte.nonTransparent === FULL) && Date.now() < deadline) {
      await page.waitForTimeout(400)
      matte = await sampleAt(page, 500_000, 600, 340)
    }
  }
  expect(matte.a).toBe(255)
  expect(matte.r).toBeLessThan(10)
  expect(matte.g).toBeLessThan(10)
  expect(matte.nonTransparent).toBe(FULL)

  // Undo the param patch and the add — chain must empty.
  await mcp.callTool({ name: 'undo', arguments: {} })
  await mcp.callTool({ name: 'undo', arguments: {} })
  await page.waitForTimeout(800)
  const s = await summary(page)
  const fx = effectsOf(s as any, bgId) as Array<{ kind: string }>
  expect(fx).toHaveLength(0)
  let restored = await sampleAt(page, 500_000, 600, 340)
  {
    const deadline = Date.now() + 6_000
    while (restored.g <= 200 && Date.now() < deadline) {
      await page.waitForTimeout(400)
      restored = await sampleAt(page, 500_000, 600, 340)
    }
  }
  expect(restored.g).toBeGreaterThan(200)

  await app.close()
})
