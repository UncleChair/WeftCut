import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Bridge } from './bridge.js'
import { createShim } from './shim.js'
import {
  authFilePath,
  clientConfigJson,
  endpointUrl,
  readAuth,
  resolveUserDataDir,
  shimEnvFromProcess,
  type ShimEnv,
} from './paths.js'

/// weftcut-mcp — the WeftCut MCP connection shim.
///
/// Default mode (no args) is an MCP server on stdio that bridges to the
/// running app's streamable-HTTP endpoint; the subcommands are the
/// terminal-facing connection helpers. Exit codes: 0 ok, 2 usage, 3 the app
/// is not reachable (info / list-tools).

const HELP = `weftcut-mcp — WeftCut MCP connection shim

usage:
  weftcut-mcp                 MCP server on stdio (what client configs run)
  weftcut-mcp info            print endpoint, token, and whether the app is running
  weftcut-mcp print-config    print the mcpServers config fragment for MCP clients
  weftcut-mcp list-tools      connect to the running app and list its MCP tools
  weftcut-mcp help            this text

The app's endpoint + bearer token are read from <userData>/mcp_auth.json at
every connect, so configs stay valid across app restarts, port changes, and
token rotations. Override the userData directory with WEFTCUT_USERDATA.`

async function runStdio(se: ShimEnv, userDataDir: string): Promise<void> {
  const shim = createShim({ se, userDataDir })
  const stop = shim.startPolling()
  shim.server.onclose = () => {
    stop()
    shim.bridge.markDown() // closes the SSE stream so the event loop can drain
  }
  await shim.server.connect(new StdioServerTransport())
  // Eager first connect: the client's initial tools/list should see the full
  // catalog without waiting for a poll tick when the app is already up.
  await shim.bridge.ensureUp()
}

/// One-shot probe bridge for the terminal subcommands (no notifications, no
/// catalog): connect, run `use`, tear down so the process can exit.
async function withBridge<T>(
  userDataDir: string,
  use: (bridge: Bridge) => Promise<T>,
): Promise<T> {
  const bridge = new Bridge({
    readAuth: () => readAuth(userDataDir),
    onUp: () => {},
    onDown: () => {},
    onNotification: () => {},
  })
  try {
    return await use(bridge)
  } finally {
    bridge.markDown()
  }
}

async function runInfo(userDataDir: string): Promise<void> {
  const auth = readAuth(userDataDir)
  console.log(`userData:  ${userDataDir}`)
  console.log(`auth file: ${authFilePath(userDataDir)}${auth ? '' : ' (missing — launch WeftCut once)'}`)
  if (!auth) {
    console.log('running:   no')
    process.exitCode = 3
    return
  }
  console.log(`endpoint:  ${endpointUrl(auth)}`)
  console.log(`token:     ${auth.token}`)
  const up = await withBridge(userDataDir, async (b) => (await b.ensureUp()) === 'up')
  console.log(`running:   ${up ? 'yes' : 'no'}`)
  if (!up) process.exitCode = 3
}

async function runListTools(userDataDir: string): Promise<void> {
  const auth = readAuth(userDataDir)
  const listing = await withBridge(userDataDir, async (b) => {
    if ((await b.ensureUp()) !== 'up') return null
    return b.forward('tools/list', {}, ListToolsResultSchema)
  })
  if (!listing) {
    console.error(
      auth
        ? `WeftCut is not running (nothing answering at ${endpointUrl(auth)}). Launch the app and retry.`
        : `WeftCut has never been launched on this machine (no mcp_auth.json under ${userDataDir}).`,
    )
    process.exitCode = 3
    return
  }
  for (const tool of listing.tools) {
    const firstLine = (tool.description ?? '').split('\n')[0] ?? ''
    console.log(firstLine ? `${tool.name} — ${firstLine}` : tool.name)
  }
}

async function main(): Promise<void> {
  const se = shimEnvFromProcess()
  const userDataDir = resolveUserDataDir(se)
  const cmd = process.argv[2]
  if (cmd === undefined) return runStdio(se, userDataDir)
  if (cmd === 'info') return runInfo(userDataDir)
  if (cmd === 'print-config') {
    console.log(clientConfigJson(se, userDataDir))
    return
  }
  if (cmd === 'list-tools') return runListTools(userDataDir)
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }
  console.error(`unknown command: ${cmd}\n\n${HELP}`)
  process.exitCode = 2
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
