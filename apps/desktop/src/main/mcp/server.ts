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
import { captureMotifFrameB64 } from '../motif/capture.js'
import { routeMcpTool } from './mutationTools.js'
import { shapeMotifMcpResult } from './motifResult.js'
import { runHybrid } from '../state/hybrids.js'
import type { TsActorHost } from '../state/ts-actor-host.js'
import { mergeMcpCatalog, mergeMcpResources } from './mcpCatalog.js'
import { MCP_TOOL_DEFS } from '../state/mcp-commands.js'
import { MOTIF_TOOL_DEFS, MOTIF_RESOURCE_DEFS } from './motifToolDefs.js'

type Backend = import('@weftcut/core').Backend

interface Envelope {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; data?: unknown }
}
const CODE_MAP: Record<string, number> = {
  invalid_params: -32602, invalid_request: -32600, not_found: -32601, internal: -32603,
}

/** Map a parsed {ok,result|error} envelope to the SDK result (or throw the
 *  SDK-shaped error). The TS actor.mcpCall returns this same shape as Rust's reply(). */
function unwrapEnvelope(env: Envelope): unknown {
  if (env.ok) return env.result
  const err = env.error!
  const e = new Error(err.message) as Error & { code?: number; data?: unknown }
  e.code = CODE_MAP[err.code] ?? -32603
  e.data = err.data
  throw e
}
function unwrap(json: string): unknown { return unwrapEnvelope(JSON.parse(json) as Envelope) }

/** CallTool routing (tsHost present): mutations → TS actor.mcpCall, hybrid →
 *  runHybrid, rust → backend (mirror-backed reads). */
export async function handleCallTool(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  name: string,
  args: Record<string, unknown>,
): Promise<ServerResult> {
  const tsHost = getTsHost()
  if (tsHost) {
    const route = routeMcpTool(name)
    if (route === 'ts') {
      const out = unwrapEnvelope(tsHost.mcpCall(name, JSON.stringify(args)))
      if (name === 'begin_agent_session') tsHost.beginAgentSessionSlot(((args.reason as string | undefined) ?? '').trim())
      return out as ServerResult
    }
    if (route === 'hybrid') {
      // Native-compute → TS-write (Phase 3d-e). import_media returns the new media
      // id; shape it as the Rust tool does (ToolResult::text(id) → text content).
      const result = await runHybrid(name, args, tsHost.hybridDeps)
      return { content: [{ type: 'text', text: String(result) }] } as unknown as ServerResult
    }
    if (route === 'motif') {
      // Catalog-read + authoring + install, served in TS (Phase 2). The raw value
      // is shaped to the Rust-faithful ToolResult (list_motifs strips html, etc.).
      const raw = tsHost.motifTool(name, args)
      return shapeMotifMcpResult(name, raw) as unknown as ServerResult
    }
    // route === 'rust' → fall through (reads are mirror-backed).
  }
  if (name === 'preview_motif_draft') {
    const a = args as { id?: string; motif_id?: string; t_sec?: number; props?: unknown; width?: number; height?: number }
    const motifId = a.id ?? a.motif_id ?? ''
    const b64 = await captureMotifFrameB64({
      motifId, tSec: a.t_sec ?? 0, propsJson: JSON.stringify(a.props ?? {}),
      width: a.width ?? 480, height: a.height ?? 480, settleRafs: null, contentHash: '',
    })
    return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] } as unknown as ServerResult
  }
  return unwrap(await backend.mcpCallTool(name, JSON.stringify(args))) as ServerResult
}

export function buildMcpServer(backend: Backend, getTsHost: () => TsActorHost | null = () => null): Server {
  const server = new Server(
    { name: 'weftcut', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const rust = (JSON.parse(await backend.mcpCatalog()) as { tools: Array<{ name: string }> }).tools
    return { tools: mergeMcpCatalog(rust, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS]) } as unknown as ServerResult
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleCallTool(backend, getTsHost, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  )
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const cat = JSON.parse(await backend.mcpCatalog()) as { resources: Array<{ uri: string }> }
    return { resources: mergeMcpResources(cat.resources, MOTIF_RESOURCE_DEFS) } as unknown as ServerResult
  })
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const tsHost = getTsHost()
    if (req.params.uri === 'motifs://current' && tsHost) {
      const raw = tsHost.motifTool('list_motifs', {}) as Array<Record<string, unknown>>
      const list = raw.map((e) => { const { html: _html, ...rest } = e; return rest })
      return { contents: [{ uri: 'motifs://current', mimeType: 'application/json', text: JSON.stringify(list) }] } as unknown as ServerResult
    }
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
