import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'hybrid' | 'motif'

/** MCP tools served by the native-compute → TS-write hybrid orchestrator. */
export const HYBRID_TOOLS: ReadonlySet<string> = new Set([
  'import_media', 'apply_subtitles',
  'acknowledge_motif_staleness',   // install_motif moved to the 'motif' route (Phase 2)
  'synthesize_speech',
])

/** Motif catalog-read + authoring + install tools, served in TS by runMotifTool
 *  (Phase 2). Their defs stay Rust-advertised this phase (mergeMcpCatalog keeps
 *  non-'ts' routes); Phase 4 moves the defs to TS and deletes the Rust arms. */
export const MOTIF_TOOLS: ReadonlySet<string> = new Set([
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'delete_motif', 'install_motif',
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
