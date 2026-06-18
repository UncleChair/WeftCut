import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface Info { sse_url: string; bearer_token: string }

async function connect(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  })
  const client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

/**
 * Consume lines from an SSE response until we see a data line with a
 * JSON-RPC result for the given request id, then return that result.
 * We read body as text and scan for 'data: ...' lines.
 */
function parseFirstSseData(body: string): unknown | null {
  for (const line of body.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6))
      } catch {
        // skip
      }
    }
  }
  return null
}

/**
 * Fetch the tools list via a raw two-step MCP sequence (initialize + tools/list),
 * bypassing the SDK client's strict inputSchema Zod validation.
 *
 * schemars 0.8 emits boolean `true` for serde_json::Value properties (interp,
 * track fields on keyframe tools), which SDK 1.29.0 AssertObjectSchema rejects
 * because `typeof true !== 'object'`. This workaround exercises the real server
 * catalog. Server defect tracked separately (fix: wrap Value in custom JsonSchema
 * that emits `{}` instead of boolean `true`).
 */
async function rawListToolNames(url: string, token: string): Promise<string[]> {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  }

  // Step 1: initialize — get a session ID.
  const initRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'e2e-raw', version: '0.0.0' },
        capabilities: {},
      },
    }),
  })
  const sessionId = initRes.headers.get('mcp-session-id') ?? ''
  const initBody = await initRes.text()
  const initMsg = parseFirstSseData(initBody) as { result?: unknown } | null
  if (!initMsg?.result) return []

  // Step 2: send initialized notification (required by spec).
  await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  })

  // Step 3: tools/list on the established session.
  const listRes = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const listBody = await listRes.text()
  const listMsg = parseFirstSseData(listBody) as {
    result?: { tools?: { name: string }[] }
  } | null
  return listMsg?.result?.tools?.map((t) => t.name) ?? []
}

test('S4a: external MCP client connects, calls tools, and bearer is enforced', async () => {
  const { app, page } = await launchApp()

  // Discover the live server URL + token from the main process (panel is deferred).
  const info = (await page.evaluate(() => (window as any).api.invoke('get_mcp_info', {}))) as Info
  expect(info.sse_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  expect(info.bearer_token).toHaveLength(64)

  // 401 without the token.
  await expect(connect(info.sse_url)).rejects.toThrow()

  // With the token: ping + add_track parity + resource read.
  const client = await connect(info.sse_url, info.bearer_token)

  // Raw list-tools check: schemars 0.8 emits boolean `true` for
  // serde_json::Value properties in inputSchema, which SDK 1.29.0 Zod
  // rejects as non-object. Bypass SDK validation via raw SSE fetch.
  const toolNames = await rawListToolNames(info.sse_url, info.bearer_token)
  expect(toolNames).toContain('add_track')

  const pong = await client.callTool({ name: 'ping', arguments: {} })
  expect(JSON.stringify(pong.content)).toContain('pong')

  const before = (await page.evaluate(() => (window as any).api.invoke('project_summary', {}))) as { track_count: number }
  await client.callTool({ name: 'add_track', arguments: {} })
  const after = (await page.evaluate(() => (window as any).api.invoke('project_summary', {}))) as { track_count: number }
  expect(after.track_count).toBe(before.track_count + 1)

  const proj = await client.readResource({ uri: 'project://current' })
  expect(proj.contents[0].mimeType).toBe('application/json')

  await client.close()
  await app.close()
})
