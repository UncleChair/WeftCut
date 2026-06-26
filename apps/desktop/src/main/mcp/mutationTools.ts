import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'hybrid' | 'motif'

/** MCP tools served by the native-compute → TS-write hybrid orchestrator. */
export const HYBRID_TOOLS: ReadonlySet<string> = new Set([
  'import_media', 'apply_subtitles', 'synthesize_speech',
])

/** Motif catalog-read + authoring + install + staleness tools, served in TS by
 *  runMotifTool. Their 6 MCP-advertised defs come from TS MOTIF_TOOL_DEFS
 *  (mcpCatalog dedups by name); the Rust arms are gone (Phase 4). */
export const MOTIF_TOOLS: ReadonlySet<string> = new Set([
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'delete_motif', 'install_motif',
  'motif_staleness_report', 'acknowledge_motif_staleness',
])

/** Where an MCP tool runs. motif → tsHost.motifTool (then shapeMotifMcpResult);
 *  hybrid → runHybrid; ts → tsHost.actor.mcpCall; rust → backend.
 *  motif-first so install_motif can never both hybrid and motif-route. */
export function routeMcpTool(name: string): McpRoute {
  if (MOTIF_TOOLS.has(name)) return 'motif'
  if (HYBRID_TOOLS.has(name)) return 'hybrid'
  if (MCP_TOOLS.has(name)) return 'ts'
  return 'rust'
}
