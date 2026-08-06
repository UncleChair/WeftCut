import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GL_SWITCHES, tmpDir } from './helpers/driver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

// Parse the `[mcp] connect: {…}` line the host logs in unpackaged runs (mcp/index.ts).
function parseConnect(line: string): { url: string; token: string } | null {
  const m = line.match(/\[mcp\] connect: (\{.*\})/)
  if (!m) return null
  const cfg = JSON.parse(m[1]) as { mcpServers: { weftcut: { url: string; headers: { Authorization: string } } } }
  const s = cfg.mcpServers.weftcut
  return { url: s.url, token: s.headers.Authorization.replace(/^Bearer /, '') }
}

test('TS actor: MCP mutate → resource read reflects it; blocked tool rejects', async () => {
  const ws = tmpDir('wc-mcp-flip-')
  // Raw electron.launch (not launchApp): the stdout listener for the
  // `[mcp] connect:` log line must attach synchronously right after launch,
  // before firstWindow resolves — launchApp awaits firstWindow internally and
  // the listener could miss the line. Still boot over an isolated userData.
  const userDataDir = tmpDir('wc-mcp-flip-userdata-')
  let connect: { url: string; token: string } | null = null
  const app = await electron.launch({
    args: [...GL_SWITCHES, `--user-data-dir=${userDataDir}`, MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
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
      // A read resource — the `project://*` state views are served by the TS MCP host.
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
