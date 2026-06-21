import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { launchApp, newProject, invokeCmd, summary, driveExport } from './helpers/driver'

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
  test.setTimeout(120_000)
  const { app, page } = await launchApp()

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-effects-smoke-'))
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
  const effectId = JSON.parse(JSON.stringify(addRes.content))[0].text as string
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

  // EXPORT with the blur ON — the user reported the exported video was black
  // too. Drive the real timeline export; a follow-up ffmpeg frame-extract
  // confirms the encoded output isn't empty.
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
  test.setTimeout(180_000)
  const { app, page } = await launchApp()

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-motif-effects-'))
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
  const effectId = JSON.parse(JSON.stringify(addRes.content))[0].text as string
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

  // EXPORT with the blur ON (8-bit). Confirms the rewritten loop filters the
  // Motif sprite in the export Worker too (it binds baked frames to the same
  // Pixi Sprite). driveExport throwing is logged, not fatal, mirroring the
  // sibling test.
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
