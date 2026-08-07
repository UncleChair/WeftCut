// The shim's catalog state machine, exercised entirely in memory: a test
// Client drives the shim's stdio face over one InMemoryTransport pair, and
// the bridge connects to a fake "app" MCP server over another. Covers the
// spec's core claims — catalog = synthetic ∪ (app alive ? real : ∅),
// list_changed on BOTH transitions, actionable down-state errors, and the
// launch_weftcut close-the-loop flow.
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createShim, type Shim } from './shim.js'
import type { McpAuth, ShimEnv } from './paths.js'

const SE: ShimEnv = {
  platform: 'win32',
  env: {},
  execPath: 'C:\\Program Files\\WeftCut\\WeftCut.exe',
  scriptPath: 'C:\\ud\\cli\\weftcut-mcp.cjs',
  homedir: 'C:\\Users\\u',
}
const AUTH: McpAuth = { token: 'tok', port: 4711 }

function fakeAppServer(): Server {
  const s = new Server(
    { name: 'weftcut', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'add_marker', description: 'Add a marker.', inputSchema: { type: 'object' as const } }],
  }))
  s.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text' as const, text: `called:${req.params.name}` }],
  }))
  s.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'project://current', name: 'project' }],
  }))
  s.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'auto-caption' }],
  }))
  return s
}

interface Harness {
  client: Client
  shim: Shim
  /// Notification methods the stdio-side client received, in order.
  notified: string[]
  /// Flip to false to make the next bridge connect fail (app "not running").
  setAppUp(up: boolean): void
  appServer(): Server | null
  close(): Promise<void>
}

async function harness(opts: { appUp: boolean; auth?: McpAuth | null; spawnApp?: (p: string) => void; launchTimeoutMs?: number }): Promise<Harness> {
  let up = opts.appUp
  let app: Server | null = null
  const makeTransport = (_auth: McpAuth): Transport => {
    if (!up) throw new Error('ECONNREFUSED')
    app = fakeAppServer()
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    void app.connect(serverT)
    return clientT
  }
  const shim = createShim({
    se: SE,
    userDataDir: 'C:\\ud',
    readAuth: () => (opts.auth === undefined ? AUTH : opts.auth),
    makeTransport,
    ...(opts.spawnApp ? { spawnApp: opts.spawnApp } : {}),
    launchTimeoutMs: opts.launchTimeoutMs ?? 300,
    launchPollMs: 20,
  })
  const notified: string[] = []
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async (n) => {
    notified.push(n.method)
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await shim.server.connect(serverT)
  await client.connect(clientT)
  return {
    client,
    shim,
    notified,
    setAppUp: (v) => {
      up = v
    },
    appServer: () => app,
    close: async () => {
      await client.close().catch(() => {})
      await shim.server.close().catch(() => {})
      shim.bridge.markDown()
    },
  }
}

let open: Harness | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

const settle = () => new Promise((r) => setTimeout(r, 25))

describe('down state', () => {
  it('lists exactly the synthetic tools, and empty resources/prompts', async () => {
    open = await harness({ appUp: false })
    const tools = await open.client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut'])
    expect((await open.client.listResources()).resources).toEqual([])
    expect((await open.client.listPrompts()).prompts).toEqual([])
  })

  it('a real tool call fails with an actionable message naming the endpoint and launch_weftcut', async () => {
    open = await harness({ appUp: false })
    const err = await open.client
      .callTool({ name: 'add_marker', arguments: {} })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpError)
    const msg = (err as McpError).message
    expect(msg).toContain('http://127.0.0.1:4711/mcp')
    expect(msg).toContain('launch_weftcut')
  })

  it('with no auth file the error says the app has never been launched', async () => {
    open = await harness({ appUp: false, auth: null })
    const err = await open.client
      .callTool({ name: 'add_marker', arguments: {} })
      .then(() => null)
      .catch((e: unknown) => e)
    expect((err as McpError).message).toContain('never been launched')
    const status = await open.client.callTool({ name: 'weftcut_status', arguments: {} })
    expect(JSON.stringify(status.content)).toContain('never been launched')
  })

  it('weftcut_status reports not-running with next steps', async () => {
    open = await harness({ appUp: false })
    const status = await open.client.callTool({ name: 'weftcut_status', arguments: {} })
    const text = JSON.stringify(status.content)
    expect(text).toContain('not running')
    expect(text).toContain('launch_weftcut')
  })
})

describe('up state', () => {
  it('lists synthetic ∪ real and passes tool calls through', async () => {
    open = await harness({ appUp: true })
    const tools = await open.client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut', 'add_marker'])
    const result = await open.client.callTool({ name: 'add_marker', arguments: { t_us: 1 } })
    expect(JSON.stringify(result.content)).toContain('called:add_marker')
    expect((await open.client.listResources()).resources).toHaveLength(1)
    expect((await open.client.listPrompts()).prompts).toHaveLength(1)
  })

  it('forwards the app change feed to the stdio client', async () => {
    open = await harness({ appUp: true })
    await open.client.listTools() // establishes the bridge
    await open.appServer()!.notification({
      method: 'notifications/weftcut/change',
      params: { summary: 'moved a clip' },
    })
    await settle()
    expect(open.notified).toContain('notifications/weftcut/change')
  })

  it('weftcut_status reports running', async () => {
    open = await harness({ appUp: true })
    const status = await open.client.callTool({ name: 'weftcut_status', arguments: {} })
    expect(JSON.stringify(status.content)).toContain('WeftCut is running')
  })
})

describe('transitions', () => {
  it('app dies mid-session → list_changed fires and the catalog degrades to synthetic-only', async () => {
    open = await harness({ appUp: true })
    await open.client.listTools()
    open.setAppUp(false)
    await open.appServer()!.close() // bridge onclose → markDown → broadcast
    await settle()
    expect(open.notified).toContain('notifications/tools/list_changed')
    const tools = await open.client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(['weftcut_status', 'launch_weftcut'])
  })

  it('app comes up mid-session → next list upgrades and list_changed fires', async () => {
    open = await harness({ appUp: false })
    expect((await open.client.listTools()).tools).toHaveLength(2)
    open.setAppUp(true)
    // The list handler's opportunistic ensureUp performs the upgrade itself.
    const tools = await open.client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('add_marker')
    await settle()
    expect(open.notified).toContain('notifications/tools/list_changed')
  })

  it('launch_weftcut spawns the app, waits for the endpoint, and closes the loop', async () => {
    let spawned: string | null = null
    open = await harness({
      appUp: false,
      spawnApp: (p) => {
        spawned = p
        open!.setAppUp(true) // "the app came up"
      },
    })
    const result = await open.client.callTool({ name: 'launch_weftcut', arguments: {} })
    expect(spawned).toBe(SE.execPath)
    expect(result.isError).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('now available')
    expect((await open.client.listTools()).tools.map((t) => t.name)).toContain('add_marker')
  })

  it('launch_weftcut reports a bounded timeout when the endpoint never appears', async () => {
    let spawned = false
    open = await harness({ appUp: false, spawnApp: () => (spawned = true), launchTimeoutMs: 80 })
    const result = await open.client.callTool({ name: 'launch_weftcut', arguments: {} })
    expect(spawned).toBe(true)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('did not come up')
  })

  it('launch_weftcut on an already-running app is a no-op report', async () => {
    let spawned = false
    open = await harness({ appUp: true, spawnApp: () => (spawned = true) })
    const result = await open.client.callTool({ name: 'launch_weftcut', arguments: {} })
    expect(spawned).toBe(false)
    expect(JSON.stringify(result.content)).toContain('already running')
  })
})
