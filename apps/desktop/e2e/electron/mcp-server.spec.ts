import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface Info { url: string; bearer_token: string }

async function connect(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  })
  const client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

test('external MCP client connects, calls tools, and bearer is enforced', async () => {
  const { app, page } = await launchApp()

  // Discover the live server URL + token from the main process (panel is deferred).
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as Info

  // Field-shape assertion: streamable-HTTP url present, SSE fields gone.
  expect(info).toHaveProperty('url')
  expect(info).not.toHaveProperty('sse_url')
  expect(info.url).toMatch(/\/mcp$/)

  expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  expect(info.bearer_token).toHaveLength(64)

  // 401 without the token.
  await expect(connect(info.url)).rejects.toThrow()

  // With the token: ping + add_track parity + resource read.
  const client = await connect(info.url, info.bearer_token)

  // Use the real SDK client.listTools() so the call goes through the Zod
  // inputSchema validator: keyframe tools (interp/track props) must emit an
  // object schema, not bare `true`, or AssertObjectSchema rejects them.
  const toolsResult = await client.listTools()
  expect(toolsResult.tools.map((t) => t.name)).toContain('add_track')

  const pong = await client.callTool({ name: 'ping', arguments: {} })
  expect(JSON.stringify(pong.content)).toContain('pong')

  const before = (await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))) as { track_count: number }
  await client.callTool({ name: 'add_track', arguments: {} })
  const after = (await page.evaluate(() => (window as any).api.backend.invoke('project_summary', {}))) as { track_count: number }
  expect(after.track_count).toBe(before.track_count + 1)

  const proj = await client.readResource({ uri: 'project://current' })
  expect(proj.contents[0].mimeType).toBe('application/json')

  await client.close()
  await app.close()
})
