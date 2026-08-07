import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { endpointUrl, type McpAuth } from './paths.js'

/// Structural stand-in for a zod schema — zod is the SDK's dependency, not
/// ours, so naming its types directly would lean on npm hoisting.
interface ParseSchema<T> {
  parse(value: unknown): T
}

/// The shim's connection to the running app: an MCP *client* over streamable
/// HTTP. Exactly one of two states — `up` (a connected Client) or `down`
/// (null). Every transition fires the injected callbacks so the stdio side
/// can broadcast `tools/list_changed` in both directions.

export type EnsureResult = 'up' | 'down' | 'no-auth'

export interface BridgeDeps {
  readAuth: () => McpAuth | null
  /// Seam for tests (InMemoryTransport). Production: streamable HTTP + bearer.
  makeTransport?: (auth: McpAuth) => Transport
  onUp: () => void
  onDown: () => void
  /// Server-initiated notifications from the app (the weftcut/change feed),
  /// forwarded verbatim to the stdio client.
  onNotification: (n: { method: string; params?: unknown }) => void
}

function httpTransport(auth: McpAuth): Transport {
  return new StreamableHTTPClientTransport(new URL(endpointUrl(auth)), {
    requestInit: { headers: { Authorization: `Bearer ${auth.token}` } },
  })
}

/// A JSON-RPC error is proof the server ANSWERED — the bridge is healthy and
/// the error belongs to the caller. Everything else (fetch refused, socket
/// reset, SDK connection-closed/timeout codes) means the app went away.
function serverAnswered(e: unknown): boolean {
  return (
    e instanceof McpError &&
    e.code !== ErrorCode.ConnectionClosed &&
    e.code !== ErrorCode.RequestTimeout
  )
}

export class Bridge {
  private client: Client | null = null
  private connecting: Promise<EnsureResult> | null = null

  constructor(private readonly deps: BridgeDeps) {}

  isUp(): boolean {
    return this.client !== null
  }

  /// App identity while bridged (name/version from the initialize handshake).
  serverVersion(): { name: string; version: string } | null {
    return (this.client?.getServerVersion() as { name: string; version: string } | undefined) ?? null
  }

  /// Connect if down. Re-reads mcp_auth.json every attempt (rotation/port
  /// re-pick self-heal). Concurrent callers (poll loop vs a tool call) share
  /// one in-flight attempt.
  ensureUp(): Promise<EnsureResult> {
    if (this.client) return Promise.resolve('up')
    if (this.connecting) return this.connecting
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectOnce(): Promise<EnsureResult> {
    const auth = this.deps.readAuth()
    if (!auth) return 'no-auth'
    const client = new Client({ name: 'weftcut-mcp', version: '1.0' }, { capabilities: {} })
    client.fallbackNotificationHandler = async (n) => {
      this.deps.onNotification(n as { method: string; params?: unknown })
    }
    try {
      const make = this.deps.makeTransport ?? httpTransport
      // Bounded initialize: on a dead port fetch rejects instantly, but a
      // half-up app must not wedge the poll loop behind the 60s SDK default.
      await client.connect(make(auth), { timeout: 3000 })
    } catch {
      await client.close().catch(() => {})
      return 'down'
    }
    client.onclose = () => this.markDown()
    this.client = client
    this.deps.onUp()
    return 'up'
  }

  /// Idempotent: onclose fires again when we close the client here.
  markDown(): void {
    const c = this.client
    if (!c) return
    this.client = null
    c.close().catch(() => {})
    this.deps.onDown()
  }

  /// Cheap liveness check for the poll loop while up.
  async pingOrMarkDown(): Promise<void> {
    const c = this.client
    if (!c) return
    try {
      await c.ping({ timeout: 3000 })
    } catch {
      this.markDown()
    }
  }

  /// Forward one request verbatim. Throws `BridgeDownError` when the app is
  /// (or just went) unreachable; rethrows the app's own JSON-RPC errors.
  async forward<T>(method: string, params: unknown, resultSchema: ParseSchema<T>): Promise<T> {
    const c = this.client
    if (!c) throw new BridgeDownError()
    try {
      return await c.request({ method, params } as never, resultSchema as never)
    } catch (e) {
      if (serverAnswered(e)) throw e
      this.markDown()
      throw new BridgeDownError()
    }
  }
}

export class BridgeDownError extends Error {
  constructor() {
    super('WeftCut is not reachable')
  }
}
