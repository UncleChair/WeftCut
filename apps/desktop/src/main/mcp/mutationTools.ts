import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'blocked' | 'hybrid'

/** Category-A MCP tools with NO TS path under WEFTCUT_TS_ACTOR — rejected -32600.
 *  Phase 3d-e is COMPLETE; project_restore_checkpoint is wired (Phase 4a-i §2.1);
 *  add_motif is a pure TS mutation (Phase 4a-ii §2.2). Slice 4a complete: ∅.
 *  motif_staleness_report is a mirror-backed READ (routes to 'rust') — NOT blocked. */
export const MCP_BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set([])

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
