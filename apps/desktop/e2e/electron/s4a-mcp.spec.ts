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

  // Real SDK client.listTools() — exercises the Zod inputSchema validator.
  // Previously this was a rawListToolNames() raw-fetch workaround because
  // schemars 0.8 emitted boolean `true` for serde_json::Value properties
  // (interp/track on keyframe tools), which SDK 1.29.0 AssertObjectSchema
  // rejects. Fixed by emitting `{}` via schema_with = "any_object_schema".
  const toolsResult = await client.listTools()
  expect(toolsResult.tools.map((t) => t.name)).toContain('add_track')

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
