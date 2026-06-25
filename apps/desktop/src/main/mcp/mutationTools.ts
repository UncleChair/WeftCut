import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'blocked' | 'hybrid'

/** Category-A MCP tools with NO TS path under WEFTCUT_TS_ACTOR — rejected -32600.
 *  The hybrid writes (import_media, apply_subtitles, synthesize_speech,
 *  install_motif, acknowledge_motif_staleness) move to HYBRID_TOOLS as each
 *  lands; the native-motif family and add_motif/project_restore_checkpoint ride
 *  Phase 4. (install_motif + acknowledge_motif_staleness landed in Phase 3d-e Task 5;
 *  synthesize_speech landed in Task 6.)
 *  motif_staleness_report is a mirror-backed READ (routes to 'rust') — NOT blocked. */
export const MCP_BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set([
  'add_motif', 'project_restore_checkpoint',
])

/** MCP tools served by the native-compute → TS-write hybrid orchestrator
 *  (hybrids.ts runHybrid). Grows as each hybrid lands (install_motif/
 *  acknowledge_motif_staleness Task 5, synthesize_speech Task 6). */
export const HYBRID_TOOLS: ReadonlySet<string> = new Set([
  'import_media', 'apply_subtitles',
  'install_motif', 'acknowledge_motif_staleness',
  'synthesize_speech',
])

/** Where an MCP tool runs under the flag. ts → tsHost.actor.mcpCall; hybrid →
 *  runHybrid(tsHost.hybridDeps); blocked → reject -32600; rust → backend (reads
 *  are mirror-backed, fresh). Blocked- and hybrid-first so a name can never both
 *  block and route to ts. */
export function routeMcpTool(name: string): McpRoute {
  if (MCP_BLOCKED_UNDER_FLAG.has(name)) return 'blocked'
  if (HYBRID_TOOLS.has(name)) return 'hybrid'
  if (MCP_TOOLS.has(name)) return 'ts'
  return 'rust'
}
