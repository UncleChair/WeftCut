import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'hybrid'

/** MCP tools served by the native-compute → TS-write hybrid orchestrator
 *  (hybrids.ts runHybrid). Grows as each hybrid lands (install_motif/
 *  acknowledge_motif_staleness Task 5, synthesize_speech Task 6). */
export const HYBRID_TOOLS: ReadonlySet<string> = new Set([
  'import_media', 'apply_subtitles',
  'install_motif', 'acknowledge_motif_staleness',
  'synthesize_speech',
])

/** Where an MCP tool runs. ts → tsHost.actor.mcpCall; hybrid →
 *  runHybrid(tsHost.hybridDeps); rust → backend (reads are mirror-backed, fresh).
 *  Hybrid-first so a name can never both run a hybrid and route to ts. */
export function routeMcpTool(name: string): McpRoute {
  if (HYBRID_TOOLS.has(name)) return 'hybrid'
  if (MCP_TOOLS.has(name)) return 'ts'
  return 'rust'
}
