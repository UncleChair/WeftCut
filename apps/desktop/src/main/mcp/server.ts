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
import type { TsActorHost } from '../state/ts-actor-host.js'

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

/** CallTool routing. Under the flag (tsHost present): mutations → TS actor.mcpCall,
 *  blocked → -32600, rust → backend (mirror-backed reads). Flag-off → backend. */
export async function handleCallTool(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  name: string,
  args: Record<string, unknown>,
): Promise<ServerResult> {
  const tsHost = getTsHost()
  if (tsHost) {
    const route = routeMcpTool(name)
    if (route === 'blocked') {
      const e = new Error(`${name} is unavailable while the TS state actor is active (WEFTCUT_TS_ACTOR); ported in a later phase`) as Error & { code?: number }
      e.code = -32600
      throw e
    }
    if (route === 'ts') {
      const out = unwrapEnvelope(tsHost.actor.mcpCall(name, JSON.stringify(args)))
      if (name === 'begin_agent_session') tsHost.beginAgentSessionSlot(((args.reason as string | undefined) ?? '').trim())
      return out as ServerResult
    }
    // route === 'rust' → fall through (reads are mirror-backed).
  }
  if (name === 'preview_motif_draft') {
    const a = args as { id?: string; motif_id?: string; t_sec?: number; props?: unknown; width?: number; height?: number }
    const motifId = a.id ?? a.motif_id ?? ''
    const b64 = await captureMotifFrameB64(backend, {
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
    const cat = JSON.parse(await backend.mcpCatalog()) as { tools: unknown[] }
    return { tools: cat.tools } as unknown as ServerResult
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleCallTool(backend, getTsHost, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  )
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
