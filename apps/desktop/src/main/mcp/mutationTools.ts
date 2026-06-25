import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'blocked'

/** Category-A MCP tools with NO TS path under WEFTCUT_TS_ACTOR — rejected -32600.
 *  Hybrid writes that need Rust compute (apply_subtitles, import_media,
 *  synthesize_speech) and install_motif ride Phase 3d-e; the native-motif
 *  family and add_motif/project_restore_checkpoint ride Phase 4. */
export const MCP_BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set([
  'apply_subtitles', 'import_media', 'synthesize_speech', 'install_motif',
  'acknowledge_motif_staleness', 'motif_staleness_report',
  'add_motif', 'project_restore_checkpoint',
])

/** Where an MCP tool runs under the flag. ts → tsHost.actor.mcpCall; blocked →
 *  reject -32600; rust → backend (reads are mirror-backed, fresh). Blocked-first
 *  so a name can never both block and route to ts. */
export function routeMcpTool(name: string): McpRoute {
  if (MCP_BLOCKED_UNDER_FLAG.has(name)) return 'blocked'
  if (MCP_TOOLS.has(name)) return 'ts'
  return 'rust'
}
