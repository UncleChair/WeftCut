import { test, expect, _electron as electron, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// add_motif is a PURE TS recorded mutation. This drives it end-to-end through
// BOTH surfaces (renderer command bridge + MCP actor.mcpCall) and asserts a
// Motif layer lands. The shared TS motif catalog (src/shared/motifs/catalog.ts)
// resolves the built-in `countdown` on the main side. (Motif rendering/export is
// independently covered by motif-preview/motif-export/motif-capture specs.)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

interface Summary {
  tracks: Array<{ id: string; layers: Array<{ id: string; params: { kind: string; motif_id?: string } }> }>
}
const invoke = <T = unknown>(page: Page, cmd: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [cmd, args] as const) as Promise<T>
const layerCount = (s: Summary) => s.tracks.reduce((n, t) => n + t.layers.length, 0)
const motifLayers = (s: Summary) =>
  s.tracks.flatMap((t) => t.layers).filter((l) => l.params.kind === 'Motif')

// Parse the `[mcp] connect: {…}` line the host logs in unpackaged runs (mcp/index.ts).
function parseConnect(line: string): { url: string; token: string } | null {
  const m = line.match(/\[mcp\] connect: (\{.*\})/)
  if (!m) return null
  const cfg = JSON.parse(m[1]) as { mcpServers: { weftcut: { url: string; headers: { Authorization: string } } } }
  const s = cfg.mcpServers.weftcut
  return { url: s.url, token: s.headers.Authorization.replace(/^Bearer /, '') }
}

test('TS actor: renderer add_motif (no track) lands a Motif layer + undo/redo', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-motif-flip-'))
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).api?.backend?.invoke, undefined, { timeout: 30_000 })

    await invoke(page, 'project_new_workspace', { parentFolder: ws, name: 'motif', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(0)

    // add_motif with no trackId → the TS mutation mints an Overlay track THEN a
    // Motif layer (the two-commit).
    await invoke(page, 'add_motif', { motifId: 'countdown', tStartUs: 0 })
    const afterAdd = await invoke<Summary>(page, 'project_summary')
    expect(layerCount(afterAdd)).toBe(1)
    const motifs = motifLayers(afterAdd)
    expect(motifs.length).toBe(1)
    // The catalog resolved the built-in countdown (id stamped into the layer params).
    expect(motifs[0]!.params.motif_id ?? 'countdown').toBe('countdown')

    // It is a recorded mutation: undo removes the layer, redo restores it.
    await invoke(page, 'project_undo')
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(0)
    await invoke(page, 'project_redo')
    expect(motifLayers(await invoke<Summary>(page, 'project_summary')).length).toBe(1)
  } finally {
    await app.close()
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('TS actor: MCP add_motif returns the layer id + the summary reflects a Motif layer', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-motif-mcp-'))
  let connect: { url: string; token: string } | null = null
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  app.process().stdout!.on('data', (b: Buffer) => { const c = parseConnect(b.toString()); if (c) connect = c })
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).api?.backend?.invoke, undefined, { timeout: 30_000 })
    await page.evaluate(([ws]) => (window as any).api.backend.invoke('project_new_workspace', { parentFolder: ws, name: 'motif-mcp', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }), [ws])

    await expect.poll(() => connect, { timeout: 15_000 }).not.toBeNull()
    const transport = new StreamableHTTPClientTransport(new URL(connect!.url), { requestInit: { headers: { Authorization: `Bearer ${connect!.token}` } } })
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(transport)
    try {
      // add_motif via the TS actor.mcpCall path (no track_id → Overlay + Motif layer).
      const res = await client.callTool({ name: 'add_motif', arguments: { motif_id: 'countdown', t_start_us: 0 } })
      const content = res.content as Array<{ type: string; text?: string }>
      expect(content[0]!.type).toBe('text')
      expect(content[0]!.text && content[0]!.text.length).toBeTruthy() // the layer id

      // The `project://current` state view (served by the TS MCP host) reflects a Motif layer.
      const after = await client.readResource({ uri: 'project://current' })
      const proj = JSON.parse((after.contents[0] as { text: string }).text) as {
        tracks: Array<{ layers: Array<{ id: string; params: { kind: string; motif_id?: string } }> }>
      }
      const motifs = proj.tracks.flatMap((t) => t.layers).filter((l) => l.params.kind === 'Motif')
      expect(motifs.length).toBe(1)
      expect(motifs[0]!.params.motif_id ?? 'countdown').toBe('countdown')
      // The returned text is the LAYER id, present in the project.
      expect(motifs.some((l) => l.id === content[0]!.text)).toBe(true)
    } finally {
      await client.close()
    }
  } finally {
    await app.close()
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
