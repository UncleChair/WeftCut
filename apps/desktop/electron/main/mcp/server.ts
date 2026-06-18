import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js'

type Backend = import('@weftcut/core').Backend

interface Envelope {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; data?: unknown }
}

const CODE_MAP: Record<string, number> = {
  invalid_params: -32602,
  invalid_request: -32600,
  not_found: -32601,
  internal: -32603,
}

function unwrap(json: string): unknown {
  const env = JSON.parse(json) as Envelope
  if (env.ok) return env.result
  const err = env.error!
  // The SDK turns a thrown McpError-shaped error into the JSON-RPC error response.
  const e = new Error(err.message) as Error & { code?: number; data?: unknown }
  e.code = CODE_MAP[err.code] ?? -32603
  e.data = err.data
  throw e
}

export function buildMcpServer(backend: Backend): Server {
  const server = new Server(
    { name: 'weftcut', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cat = JSON.parse(await backend.mcpCatalog()) as { tools: unknown[] }
    return { tools: cat.tools } as unknown as ServerResult
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return unwrap(
      await backend.mcpCallTool(req.params.name, JSON.stringify(req.params.arguments ?? {})),
    ) as ServerResult
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const cat = JSON.parse(await backend.mcpCatalog()) as { resources: unknown[] }
    return { resources: cat.resources } as unknown as ServerResult
  })
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    return unwrap(await backend.mcpReadResource(req.params.uri)) as ServerResult
  })
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: JSON.parse(await backend.mcpListPrompts()) } as unknown as ServerResult
  })
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    return unwrap(
      await backend.mcpGetPrompt(req.params.name, JSON.stringify(req.params.arguments ?? {})),
    ) as ServerResult
  })

  return server
}
