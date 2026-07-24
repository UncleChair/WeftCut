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
import { CLIP_SLICE_TOOLS, resolveClipSliceArgs } from '../state/clip-slice-forward.js'
import { serveProjectResource, buildResourceInjection } from '../state/resource-views.js'
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

/** Per-call VLM config provider (describe_clip + media://{id}/description): the
 *  merged backend-config snapshot the stateless resolver reads (ADR 0024) keyed
 *  by backend tag, plus the user's SOFT preferred engine. VLM config is not held
 *  on the napi `Backend` like speech — it rides in with each call. */
type VlmProvider = () => { config: Record<string, unknown>; preferred: string | null }
const NO_VLM: VlmProvider = () => ({ config: {}, preferred: null })

/** CallTool routing (tsHost present): mutations → TS actor.mcpCall, hybrid →
 *  runHybrid, rust → backend (native reads/compute that take an injected state slice). */
export async function handleCallTool(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  name: string,
  args: Record<string, unknown>,
  getPreferredEngine: () => string | null = () => null,
  getVlm: VlmProvider = NO_VLM,
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
      // Native-compute → TS-write. import_media returns the new media
      // id; shape it as the Rust tool does (ToolResult::text(id) → text content).
      const result = await runHybrid(name, args, tsHost.hybridDeps)
      return { content: [{ type: 'text', text: String(result) }] } as unknown as ServerResult
    }
    if (route === 'motif') {
      // Catalog-read + authoring + install, served in TS. The raw value
      // is shaped to the Rust-faithful ToolResult (list_motifs strips html, etc.).
      const raw = tsHost.motifTool(name, args)
      return shapeMotifMcpResult(name, raw) as unknown as ServerResult
    }
    // Clip compute (detect_silences / transcribe_clip audio; describe_clip
    // video) routes to 'rust', but the Rust core holds no state: resolve the
    // { layer, media } slice from the actor (sole state owner) and forward it.
    // NOTE: describe_clip additionally reads an injected `vlm_config` snapshot
    // (its config is stateless, ADR 0024). Wiring that snapshot in from the
    // vlm-config store + cloud keys is the one remaining integration step (it
    // lives in index.ts, out of this change's scope); until then describe_clip
    // resolves against an empty config and returns the actionable
    // "no video-understanding backend available" error.
    if (CLIP_SLICE_TOOLS.has(name)) {
      const merged = resolveClipSliceArgs(args, tsHost.actor.snapshot())
      // Inject the user's preferred engine as the SOFT `preferred_backend`
      // hint (ADR 0036: select by user preference THEN availability). The
      // agent-visible `backend` arg is deliberately NOT touched — it is a
      // STRICT override in Rust (that engine or an error, never a substitute),
      // so conflating the two would turn a mere preference into a hard
      // requirement (or worse, a hard requirement into a silent fallback).
      // "auto"/unset injects nothing; the Rust resolver's DEFAULT_ORDER decides.
      if (name === 'transcribe_clip' && merged.backend == null) {
        const pref = getPreferredEngine()
        if (pref && pref !== 'auto') merged.preferred_backend = pref
      }
      // describe_clip: inject the stateless VLM backend-config snapshot (ADR
      // 0024) it resolves against, plus the SOFT preferred-engine hint — same
      // soft/strict split as transcribe_clip (the agent-visible `backend` stays
      // a STRICT override, so only fill preferred_backend when it is unset).
      if (name === 'describe_clip') {
        const vlm = getVlm()
        merged.vlm_config = vlm.config
        if (merged.backend == null && vlm.preferred && vlm.preferred !== 'auto') {
          merged.preferred_backend = vlm.preferred
        }
      }
      return unwrap(await backend.mcpCallTool(name, JSON.stringify(merged))) as ServerResult
    }
    // route === 'rust' → fall through (other reads are served by the backend).
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

/** ReadResource routing (tsHost present): project:// state views served in TS from
 *  the actor (sole state owner); the Rust-compute resources (project://compiled,
 *  media://*, composition://meter) forwarded to the backend with an injected
 *  slice. */
export async function handleReadResource(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  uri: string,
  getVlm: VlmProvider = NO_VLM,
): Promise<ServerResult> {
  const tsHost = getTsHost()
  if (tsHost) {
    if (uri === 'motifs://current') {
      const raw = tsHost.motifTool('list_motifs', {}) as Array<Record<string, unknown>>
      const list = raw.map((e) => { const { html: _html, ...rest } = e; return rest })
      return { contents: [{ uri: 'motifs://current', mimeType: 'application/json', text: JSON.stringify(list) }] } as unknown as ServerResult
    }
    const served = serveProjectResource(uri, tsHost.actor)
    if (served) return served
    // project://compiled / media://* / composition://meter stay Rust compute —
    // inject the project / MediaItem / nothing the stateless reader now needs.
    const injection = buildResourceInjection(uri, tsHost.actor.snapshot(), getVlm().config)
    return unwrap(await backend.mcpReadResource(uri, injection)) as ServerResult
  }
  return unwrap(await backend.mcpReadResource(uri)) as ServerResult
}

export function buildMcpServer(backend: Backend, getTsHost: () => TsActorHost | null = () => null, getPreferredEngine: () => string | null = () => null, getVlm: VlmProvider = NO_VLM): Server {
  const server = new Server(
    { name: 'weftcut', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const rust = (JSON.parse(await backend.mcpCatalog()) as { tools: Array<{ name: string }> }).tools
    return { tools: mergeMcpCatalog(rust, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS]) } as unknown as ServerResult
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleCallTool(backend, getTsHost, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, getPreferredEngine, getVlm),
  )
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const cat = JSON.parse(await backend.mcpCatalog()) as { resources: Array<{ uri: string }> }
    return { resources: mergeMcpResources(cat.resources, MOTIF_RESOURCE_DEFS) } as unknown as ServerResult
  })
  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    handleReadResource(backend, getTsHost, req.params.uri, getVlm),
  )
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
