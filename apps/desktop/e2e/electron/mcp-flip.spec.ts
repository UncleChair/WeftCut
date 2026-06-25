import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

// Parse the `[mcp] connect: {…}` line the host logs in unpackaged runs (mcp/index.ts:123).
function parseConnect(line: string): { url: string; token: string } | null {
  const m = line.match(/\[mcp\] connect: (\{.*\})/)
  if (!m) return null
  const cfg = JSON.parse(m[1]) as { mcpServers: { weftcut: { url: string; headers: { Authorization: string } } } }
  const s = cfg.mcpServers.weftcut
  return { url: s.url, token: s.headers.Authorization.replace(/^Bearer /, '') }
}

test('WEFTCUT_TS_ACTOR flip: MCP mutate → resource read reflects it; blocked tool rejects', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mcp-flip-'))
  let connect: { url: string; token: string } | null = null
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_TS_ACTOR: '1', WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  app.process().stdout!.on('data', (b: Buffer) => { const c = parseConnect(b.toString()); if (c) connect = c })
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).api?.backend?.invoke, undefined, { timeout: 30_000 })
    // New workspace (TS orchestrator) so there's a project + tracks.
    await page.evaluate(([ws]) => (window as any).api.backend.invoke('project_new_workspace', { parentFolder: ws, name: 'mcp', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }), [ws])
    // Wait for the connect log, then open an MCP client.
    await expect.poll(() => connect, { timeout: 15_000 }).not.toBeNull()
    const transport = new StreamableHTTPClientTransport(new URL(connect!.url), { requestInit: { headers: { Authorization: `Bearer ${connect!.token}` } } })
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(transport)
    try {
      // A read resource served from the Rust read-mirror (TS state).
      const before = await client.readResource({ uri: 'project://tracks' })
      const tracks = JSON.parse((before.contents[0] as { text: string }).text) as Array<{ id: string }>
      expect(tracks.length).toBeGreaterThan(0)
      // Mutate via the TS actor.mcpCall path.
      const added = await client.callTool({ name: 'add_color_layer', arguments: { track_id: tracks[0].id, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 } })
      expect((added.content as Array<{ type: string }>)[0].type).toBe('text')
      // The mirror reflects the mutation on the next read.
      const after = await client.readResource({ uri: 'project://current' })
      const proj = JSON.parse((after.contents[0] as { text: string }).text) as { tracks: Array<{ layers: unknown[] }> }
      expect(proj.tracks.reduce((n, t) => n + t.layers.length, 0)).toBe(1)
      // A blocked hybrid rejects.
      await expect(client.callTool({ name: 'import_media', arguments: { path: '/nope.mp4' } })).rejects.toThrow()
    } finally {
      await client.close()
    }
  } finally {
    await app.close()
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
