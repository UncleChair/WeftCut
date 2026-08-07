import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Bridge, BridgeDownError } from './bridge.js'
import { endpointUrl, launchTarget, readAuth, type McpAuth, type ShimEnv } from './paths.js'

/// The stdio face of the shim: a real MCP server, not a byte pipe. Its
/// catalog is `synthetic ∪ (app reachable ? real catalog : ∅)` — the two
/// synthetic tools are ALWAYS present, so an agent can discover WeftCut and
/// bring it up even when nothing is listening yet, and `tools/list_changed`
/// fires on every bridge transition so the same session upgrades (and
/// downgrades) in place.

const SYNTHETIC_TOOLS: Tool[] = [
  {
    name: 'weftcut_status',
    description:
      'Report whether the WeftCut desktop app is currently running and reachable. ' +
      'Returns the endpoint state and what to do next when it is not running. ' +
      'Costs nothing; call this first when WeftCut tools appear to be missing or failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'launch_weftcut',
    description:
      'Launch the WeftCut desktop app (opens its GUI window on the user’s machine) and ' +
      'wait until its MCP endpoint is reachable. On success the full WeftCut tool catalog ' +
      'becomes available in this session automatically (tools/list_changed). Safe to call ' +
      'when already running — reports that instead of launching twice. Use after ' +
      'weftcut_status says the app is not running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function text(s: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return isError ? { content: [{ type: 'text', text: s }], isError: true } : { content: [{ type: 'text', text: s }] }
}

export interface ShimOptions {
  se: ShimEnv
  userDataDir: string
  /// Test seams. Defaults: read mcp_auth.json / streamable HTTP / detached spawn.
  readAuth?: () => McpAuth | null
  makeTransport?: (auth: McpAuth) => Transport
  spawnApp?: (targetPath: string) => void
  launchTimeoutMs?: number
  launchPollMs?: number
}

export interface Shim {
  server: Server
  bridge: Bridge
  /// Background reconnect/liveness loop. Returns the stop function.
  startPolling(intervalMs?: number): () => void
}

/// Detached GUI spawn: the child must outlive the shim, and must NOT inherit
/// ELECTRON_RUN_AS_NODE or the "app" would come up as a node interpreter
/// running no script.
function defaultSpawnApp(targetPath: string): void {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(targetPath, [], { detached: true, stdio: 'ignore', env })
  child.unref()
}

export function createShim(opts: ShimOptions): Shim {
  const { se, userDataDir } = opts
  const readAuthFn = opts.readAuth ?? (() => readAuth(userDataDir))
  const spawnApp = opts.spawnApp ?? defaultSpawnApp
  const launchTimeoutMs = opts.launchTimeoutMs ?? 45_000
  const launchPollMs = opts.launchPollMs ?? 1_000

  const server = new Server(
    { name: 'weftcut-mcp', version: '1.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
    },
  )

  // Before the stdio transport connects (or after it closes) notification
  // sends throw — transitions at those moments have nothing to tell anyway.
  const broadcastCatalogChanged = (): void => {
    server.sendToolListChanged().catch(() => {})
    server.sendResourceListChanged().catch(() => {})
    server.sendPromptListChanged().catch(() => {})
  }

  const bridge = new Bridge({
    readAuth: readAuthFn,
    ...(opts.makeTransport ? { makeTransport: opts.makeTransport } : {}),
    onUp: broadcastCatalogChanged,
    onDown: broadcastCatalogChanged,
    onNotification: (n) => {
      // The app's change feed (notifications/weftcut/change), forwarded so a
      // shim-connected agent sees edits exactly like an HTTP-direct one.
      server.notification(n as { method: string; params?: Record<string, unknown> }).catch(() => {})
    },
  })

  /// Everything actionable rides the MESSAGE: several MCP clients (Claude
  /// Code among them) surface only `code: message` to the model and drop
  /// structured error data.
  const downError = (): McpError => {
    const auth = readAuthFn()
    if (!auth) {
      return new McpError(
        ErrorCode.InternalError,
        `WeftCut has never been launched on this machine (no mcp_auth.json under ${userDataDir}). ` +
          'Ask the user to open WeftCut once so it creates its MCP endpoint, then call weftcut_status.',
      )
    }
    return new McpError(
      ErrorCode.InternalError,
      `WeftCut is not running (nothing answering at ${endpointUrl(auth)}). ` +
        'Call the launch_weftcut tool to start it, or ask the user to open WeftCut; ' +
        'the full tool catalog appears in this session automatically once the app is up.',
    )
  }

  async function statusResult(): Promise<ReturnType<typeof text>> {
    await bridge.ensureUp()
    if (bridge.isUp()) {
      const v = bridge.serverVersion()
      const auth = readAuthFn()
      return text(
        [
          `WeftCut is running${v ? ` (${v.name} ${v.version})` : ''}.`,
          auth ? `Endpoint: ${endpointUrl(auth)}` : '',
          'The full tool catalog is available in this session.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    const auth = readAuthFn()
    if (!auth) {
      return text(
        [
          'WeftCut is not running, and has never been launched on this machine ' +
            `(no mcp_auth.json under ${userDataDir}).`,
          'Ask the user to open WeftCut once so it creates its MCP endpoint, then call weftcut_status again.',
        ].join('\n'),
      )
    }
    return text(
      [
        `WeftCut is not running (nothing answering at ${endpointUrl(auth)}).`,
        'Call launch_weftcut to start it, or ask the user to open WeftCut. ' +
          'The full tool catalog appears automatically once the app is up.',
      ].join('\n'),
    )
  }

  async function launchResult(): Promise<ReturnType<typeof text>> {
    if ((await bridge.ensureUp()) === 'up') {
      return text('WeftCut is already running — the full tool catalog is available.')
    }
    const target = launchTarget(se)
    if (!target.launchable) {
      return text(
        'This shim is running under a plain Node interpreter (dev), so it does not know the ' +
          'WeftCut app binary to launch. Start the app manually (npm run dev), or set the ' +
          'WEFTCUT_APP environment variable to a launchable WeftCut executable.',
        true,
      )
    }
    try {
      spawnApp(target.path)
    } catch (e) {
      return text(`Failed to launch WeftCut (${target.path}): ${e instanceof Error ? e.message : String(e)}`, true)
    }
    const deadline = Date.now() + launchTimeoutMs
    while (Date.now() < deadline) {
      await sleep(launchPollMs)
      if ((await bridge.ensureUp()) === 'up') {
        return text(
          'WeftCut launched and its MCP endpoint is up. The full tool catalog is now available ' +
            'in this session (tools/list_changed was sent).',
        )
      }
    }
    return text(
      `WeftCut was launched (${target.path}) but its MCP endpoint did not come up within ` +
        `${Math.round(launchTimeoutMs / 1000)}s. The app may still be starting — call weftcut_status to re-check.`,
      true,
    )
  }

  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    // Opportunistic reconnect: a list request is exactly when a just-started
    // app should become visible without waiting on the poll tick.
    await bridge.ensureUp()
    // Synthetic tools ride the FIRST page only — a cursor means the client is
    // continuing a real-catalog listing.
    const synthetic = req.params?.cursor ? [] : SYNTHETIC_TOOLS
    if (!bridge.isUp()) return { tools: synthetic }
    try {
      const real = await bridge.forward('tools/list', req.params, ListToolsResultSchema)
      const taken = new Set(synthetic.map((t) => t.name))
      return { ...real, tools: [...synthetic, ...real.tools.filter((t) => !taken.has(t.name))] }
    } catch (e) {
      if (e instanceof BridgeDownError) return { tools: synthetic }
      throw e
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    if (name === 'weftcut_status') return statusResult()
    if (name === 'launch_weftcut') return launchResult()
    await bridge.ensureUp()
    try {
      return await bridge.forward('tools/call', req.params, CallToolResultSchema)
    } catch (e) {
      if (e instanceof BridgeDownError) throw downError()
      throw e
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async (req) => {
    await bridge.ensureUp()
    if (!bridge.isUp()) return { resources: [] }
    try {
      return await bridge.forward('resources/list', req.params, ListResourcesResultSchema)
    } catch (e) {
      if (e instanceof BridgeDownError) return { resources: [] }
      throw e
    }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    await bridge.ensureUp()
    try {
      return await bridge.forward('resources/read', req.params, ReadResourceResultSchema)
    } catch (e) {
      if (e instanceof BridgeDownError) throw downError()
      throw e
    }
  })

  server.setRequestHandler(ListPromptsRequestSchema, async (req) => {
    await bridge.ensureUp()
    if (!bridge.isUp()) return { prompts: [] }
    try {
      return await bridge.forward('prompts/list', req.params, ListPromptsResultSchema)
    } catch (e) {
      if (e instanceof BridgeDownError) return { prompts: [] }
      throw e
    }
  })

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    await bridge.ensureUp()
    try {
      return await bridge.forward('prompts/get', req.params, GetPromptResultSchema)
    } catch (e) {
      if (e instanceof BridgeDownError) throw downError()
      throw e
    }
  })

  const startPolling = (intervalMs = 10_000): (() => void) => {
    const timer = setInterval(() => {
      if (bridge.isUp()) void bridge.pingOrMarkDown()
      else void bridge.ensureUp()
    }, intervalMs)
    // unref: the poll must never keep the process alive once stdio closes.
    timer.unref()
    return () => clearInterval(timer)
  }

  return { server, bridge, startPolling }
}
