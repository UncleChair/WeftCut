import express from 'express'
import { app } from 'electron'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { buildMcpServer, type McpServerOptions } from './server.js'
import { loadOrInitAuth, saveAuth, rotateToken, type McpAuth } from './auth.js'
import { listenLoopback } from './bind.js'

type Backend = import('@weftcut/core').Backend

export interface McpInfoView {
  bind: string
  url: string
  bearer_token: string
}

export interface McpHost {
  getInfo(): McpInfoView
  resetToken(): string
  notifyChange(summary: unknown): void
  close(): Promise<void>
}

/** Host-level seams, forwarded verbatim to every per-session `buildMcpServer`. */
export type McpHostOptions = McpServerOptions

export async function startMcpHost(backend: Backend, opts: McpHostOptions = {}): Promise<McpHost> {
  let auth: McpAuth = loadOrInitAuth()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const servers = new Set<Server>()

  const appExpress = express()
  appExpress.use(express.json({ limit: '50mb' }))

  // Constant-time compare: a plain `!==` leaks timing. Not a real attack surface
  // for a 256-bit localhost token, but timingSafeEqual is the correct form.
  const bearerOk = (header: string | undefined): boolean => {
    if (typeof header !== 'string') return false
    const got = Buffer.from(header)
    const want = Buffer.from(`Bearer ${auth.token}`)
    return got.length === want.length && timingSafeEqual(got, want)
  }
  appExpress.use('/mcp', (req, res, next) => {
    if (!bearerOk(req.headers.authorization)) {
      res
        .status(401)
        .json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null })
      return
    }
    next()
  })

  appExpress.all('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    let transport = sid ? transports.get(sid) : undefined
    if (transport) {
      // Existing session — route straight through.
      await transport.handleRequest(req, res, req.body)
      return
    }
    // No usable existing transport: only allow a fresh initialize request.
    if (!sid && isInitializeRequest(req.body)) {
      let newServer: Server | undefined
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!)
        },
        // DNS-rebinding defense-in-depth: a malicious web page the user visits
        // can POST to our loopback port, so reject requests whose Host header
        // isn't our bind. The 256-bit bearer is still the primary gate; Origin
        // is left unrestricted so non-browser MCP clients (no/odd Origin) work.
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      })
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId)
        if (newServer) servers.delete(newServer)
      }
      newServer = buildMcpServer(backend, opts)
      servers.add(newServer)
      // Cast: the SDK declares Transport.onclose as a getter typed
      // `(() => void) | undefined`, which TS won't accept against the optional
      // `onclose?: () => void` of the `Transport` interface under
      // `exactOptionalPropertyTypes`. Runtime-compatible; narrow to Transport.
      await newServer.connect(transport as Transport)
      await transport.handleRequest(req, res, req.body)
      return
    }
    // Non-init request with no/stale session — reject without allocating.
    res
      .status(400)
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: null })
  })

  // The stored port is only a hint; listenLoopback explains why it goes
  // stale and why re-picking is safe for connected clients.
  const { server: http, port } = await listenLoopback(appExpress, auth.port)
  auth = { ...auth, port }
  saveAuth(auth)

  const url = `http://127.0.0.1:${port}/mcp`
  console.log(`[mcp] listening ${url}`)
  // The connect snippet embeds the bearer token. Print it ONLY in unpackaged
  // (dev / e2e) runs — never in a packaged build, where stdout/log capture on a
  // shared machine could leak the token. The token is always available to the
  // UI via the get_mcp_info IPC.
  if (!app.isPackaged) {
    console.log(
      `[mcp] connect: ${JSON.stringify({
        mcpServers: { weftcut: { url, headers: { Authorization: `Bearer ${auth.token}` } } },
      })}`,
    )
  }

  return {
    getInfo(): McpInfoView {
      return { bind: `127.0.0.1:${port}`, url, bearer_token: auth.token }
    },
    resetToken(): string {
      auth = rotateToken(auth)
      return auth.token
    },
    notifyChange(summary): void {
      for (const server of servers) {
        server
          .notification({
            method: 'notifications/weftcut/change',
            params: summary as Record<string, unknown>,
          })
          .catch(() => {
            /* session may have closed */
          })
      }
    },
    async close(): Promise<void> {
      for (const t of transports.values()) await t.close().catch(() => {})
      http.close()
    },
  }
}
