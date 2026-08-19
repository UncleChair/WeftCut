import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'

// `mcp/index.ts` reads `app.isPackaged` to decide whether to print the connect
// snippet; packaged keeps the bearer token out of the test output.
vi.mock('electron', () => ({ app: { isPackaged: true } }))
// A fixed token, and no <userData> read/write: the real auth store needs a
// userData path and this spec only needs "the right bearer" to be knowable.
vi.mock('./auth.js', () => ({
  loadOrInitAuth: () => ({ token: 'test-token', port: 0 }),
  saveAuth: () => {},
  rotateToken: (a: { token: string; port: number }) => ({ ...a, token: 'next-token' }),
}))
// preview_motif_draft's route ends in a real CDP frame capture. Nothing here
// reaches it; the stub is what keeps importing the host cheap.
vi.mock('../motif/capture.js', () => ({ captureMotifFrameB64: async () => '' }))

import { startMcpHost, type McpHost } from './index'
import type { McpLogDeps, McpLogEntryInput } from './withLog'

type Backend = import('@weftcut/core').Backend

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest-client', version: '9.9.9' },
  },
}

const hosts: McpHost[] = []
const sockets: http.ClientRequest[] = []

afterEach(async () => {
  // Destroy the client side first: an initialize POST is answered with an SSE
  // stream that stays open, so the runner would otherwise wait on it.
  for (const req of sockets.splice(0)) req.destroy()
  for (const host of hosts.splice(0)) await host.close()
  vi.restoreAllMocks()
})

function collector(): { rows: McpLogEntryInput[]; deps: McpLogDeps } {
  const rows: McpLogEntryInput[] = []
  return { rows, deps: { emit: (e) => { rows.push(e) }, currentWorkspace: () => null } }
}

/** Start a host over a backend no lifecycle row ever reaches — only the six
 *  request handlers touch it, and this spec issues no tool calls. */
async function start(deps: McpLogDeps): Promise<{ host: McpHost; port: number }> {
  const host = await startMcpHost({} as Backend, { log: deps })
  hosts.push(host)
  const bind = host.getInfo().bind
  return { host, port: Number(bind.slice(bind.lastIndexOf(':') + 1)) }
}

/** One POST to /mcp, resolved on the response head. The transport answers a
 *  request-bearing POST with an open SSE stream, and every assertion below needs
 *  only the status and the session id it carries. */
function post(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; sessionId: string | undefined }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        res.resume()
        resolve({ status: res.statusCode ?? 0, sessionId: res.headers['mcp-session-id'] as string | undefined })
      },
    )
    sockets.push(req)
    req.on('error', reject)
    req.end(payload)
  })
}

/** The rows arrive from SDK callbacks a microtask or two behind the HTTP
 *  response, so wait on the row rather than on the reply. */
async function rowWith(rows: McpLogEntryInput[], message: string): Promise<McpLogEntryInput> {
  const deadline = Date.now() + 2000
  let found = rows.find((r) => r.message === message)
  while (!found && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
    found = rows.find((r) => r.message === message)
  }
  expect(found, `no row \`${message}\` in ${JSON.stringify(rows.map((r) => r.message))}`).toBeDefined()
  return found!
}

describe('MCP host lifecycle rows', () => {
  it('records the bind, which no workspace can yet be open for', async () => {
    const { rows, deps } = collector()
    const { port } = await start(deps)

    const bound = await rowWith(rows, `MCP host listening on 127.0.0.1:${port}`)
    expect(bound.level).toBe('info')
    expect(bound.source).toEqual({ kind: 'System' })
    expect(bound.category).toEqual({ kind: 'Mcp' })
  })

  it('records a bad bearer as its own Warn row', async () => {
    const { rows, deps } = collector()
    const { port } = await start(deps)

    const reply = await post(port, INITIALIZE, { authorization: 'Bearer wrong', 'user-agent': 'prober/1' })

    expect(reply.status).toBe(401)
    const rejected = await rowWith(rows, 'MCP request rejected: unauthorized')
    expect(rejected.level).toBe('warn')
    expect(rejected.source).toEqual({ kind: 'System' })
    expect(rejected.details).toMatchObject({ method: 'POST', user_agent: 'prober/1' })
    // The producer owns keeping the credential out of `message`; redact_and_cap
    // only ever sees `details`.
    expect(JSON.stringify(rows)).not.toContain('test-token')
  })

  it('records a disallowed Host distinctly from a bad bearer', async () => {
    const { rows, deps } = collector()
    const { port } = await start(deps)

    // Authenticated, so the 401 gate passes and a transport is built — which is
    // the only reason the Host check runs at all.
    const reply = await post(port, INITIALIZE, { authorization: 'Bearer test-token', host: 'rebind.example' })

    expect(reply.status).toBe(403)
    const rejected = await rowWith(rows, 'MCP request rejected: host not allowed')
    expect(rejected.level).toBe('warn')
    expect(rejected.details).toMatchObject({ error: 'Invalid Host header: rebind.example' })
    expect(rows.some((r) => r.message === 'MCP request rejected: unauthorized')).toBe(false)
  })

  it('names the real client on connect and stays quiet at Info on disconnect', async () => {
    const { rows, deps } = collector()
    const { host, port } = await start(deps)

    const init = await post(port, INITIALIZE, { authorization: 'Bearer test-token' })
    expect(init.sessionId).toBeTruthy()
    // `oninitialized` fires on the notification, not on the initialize request.
    const ack = await post(
      port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { authorization: 'Bearer test-token', 'mcp-session-id': init.sessionId! },
    )
    expect(ack.status).toBe(202)

    const connected = await rowWith(rows, 'MCP client connected: vitest-client/9.9.9')
    expect(connected.level).toBe('info')
    expect(connected.details).toMatchObject({
      client_info: { name: 'vitest-client', version: '9.9.9' },
      session_id: init.sessionId,
    })

    await host.close()
    const gone = await rowWith(rows, 'MCP client disconnected')
    expect(gone.level).toBe('debug')
    expect(gone.details).toMatchObject({ session_id: init.sessionId })
  })

  it('records a rotation without recording either token', async () => {
    const { rows, deps } = collector()
    const { host } = await start(deps)

    const next = host.resetToken()

    const rotated = await rowWith(rows, 'MCP bearer token rotated')
    expect(rotated.level).toBe('info')
    expect(rotated.source).toEqual({ kind: 'User' })
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(next)
    expect(dump).not.toContain('test-token')
  })
})
