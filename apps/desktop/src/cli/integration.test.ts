// End-to-end over real transports: esbuild-bundle the shim (the same build
// scripts/build-cli.mjs ships), spawn it as a child process on stdio, and
// bridge it to a real express + StreamableHTTPServerTransport fake app — the
// same server shape the Electron main process hosts. Proves the packaged
// artefact works: stdio framing, WEFTCUT_USERDATA discovery, bearer auth,
// catalog union, and the down-state degradation.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = 'itest-token'

let tmp: string
let bundle: string
let http: HttpServer | null = null

/// Minimal replica of src/main/mcp/index.ts hosting: bearer-gated /mcp with
/// one streamable-HTTP session per initialize.
async function startFakeApp(): Promise<number> {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/mcp', (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null })
      return
    }
    next()
  })
  const transports = new Map<string, StreamableHTTPServerTransport>()
  app.all('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    let transport = sid ? transports.get(sid) : undefined
    if (transport) {
      await transport.handleRequest(req, res, req.body)
      return
    }
    if (!sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!)
        },
      })
      const server = new Server({ name: 'weftcut', version: '0.0.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'add_marker', description: 'Add a marker.', inputSchema: { type: 'object' as const } }],
      }))
      server.setRequestHandler(CallToolRequestSchema, async (r) => ({
        content: [{ type: 'text' as const, text: `called:${r.params.name}` }],
      }))
      await server.connect(transport as Transport)
      await transport.handleRequest(req, res, req.body)
      return
    }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'no session' }, id: null })
  })
  http = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  return (http!.address() as { port: number }).port
}

/// Spawn the built bundle on stdio, run `use`, tear the child down.
async function withShimClient<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: { ...process.env, WEFTCUT_USERDATA: tmp } as Record<string, string>,
    stderr: 'ignore',
  })
  const client = new Client({ name: 'itest', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  try {
    return await use(client)
  } finally {
    await client.close().catch(() => {})
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-shim-itest-'))
  bundle = path.join(tmp, 'weftcut-mcp.cjs')
  await build({
    entryPoints: [path.join(HERE, 'main.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    logLevel: 'silent',
  })
  const port = await startFakeApp()
  fs.writeFileSync(path.join(tmp, 'mcp_auth.json'), JSON.stringify({ token: TOKEN, port }))
}, 30_000)

afterAll(() => {
  http?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('bundled shim over real stdio + HTTP', () => {
  it('serves synthetic ∪ real and passes calls through (bearer included)', async () => {
    await withShimClient(async (client) => {
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut', 'add_marker'])
      const result = await client.callTool({ name: 'add_marker', arguments: {} })
      expect(JSON.stringify(result.content)).toContain('called:add_marker')
    })
  }, 20_000)

  it('degrades to the synthetic surface when the app goes away', async () => {
    const port = (http!.address() as { port: number }).port
    http!.close()
    http = null
    // Auth file still names the (now-dead) port — the down-with-auth shape.
    fs.writeFileSync(path.join(tmp, 'mcp_auth.json'), JSON.stringify({ token: TOKEN, port }))
    await withShimClient(async (client) => {
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut'])
      const status = await client.callTool({ name: 'weftcut_status', arguments: {} })
      expect(JSON.stringify(status.content)).toContain('not running')
    })
  }, 20_000)

  it('print-config emits the machine-specific stdio fragment', () => {
    const out = spawnSync(process.execPath, [bundle, 'print-config'], {
      encoding: 'utf8',
      env: { ...process.env, WEFTCUT_USERDATA: tmp },
    })
    const parsed = JSON.parse(out.stdout) as {
      mcpServers: { weftcut: { command: string; args: string[]; env: Record<string, string> } }
    }
    expect(parsed.mcpServers.weftcut.args).toEqual([bundle])
    expect(parsed.mcpServers.weftcut.env.WEFTCUT_USERDATA).toBe(tmp)
    expect(JSON.stringify(parsed)).not.toContain(TOKEN)
  }, 20_000)
})
