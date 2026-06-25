import { describe, it, expect } from 'vitest'
import { routeMcpTool, MCP_BLOCKED_UNDER_FLAG, HYBRID_TOOLS } from './mutationTools'
import { MCP_TOOLS } from '../state/mcp-commands'

describe('routeMcpTool', () => {
  it('routes ported mutations + reads to ts', () => {
    for (const t of ['add_color_layer', 'set_keyframe', 'undo', 'get_param_track', 'list_checkpoints', 'dry_run'])
      expect(routeMcpTool(t), t).toBe('ts')
  })
  it('routes import_media to the native-compute → TS-write hybrid', () => {
    expect(routeMcpTool('import_media')).toBe('hybrid')
  })
  it('blocks the not-yet-ported hybrids + Phase-4 tools', () => {
    for (const t of ['apply_subtitles', 'synthesize_speech', 'install_motif', 'acknowledge_motif_staleness', 'motif_staleness_report', 'add_motif', 'project_restore_checkpoint'])
      expect(routeMcpTool(t), t).toBe('blocked')
  })
  it('routes reads + native-read tools to rust', () => {
    for (const t of ['groups_list', 'groups_get', 'ping', 'list_motifs', 'get_motif_source', 'preview_motif_draft', 'detect_silences', 'transcribe_clip'])
      expect(routeMcpTool(t), t).toBe('rust')
  })
  it('single-writer invariant: every TS-adapter tool routes to ts, never rust', () => {
    for (const t of MCP_TOOLS) expect(routeMcpTool(t), t).toBe('ts')
  })
  it('no blocked tool is also a TS-adapter tool', () => {
    for (const t of MCP_BLOCKED_UNDER_FLAG) expect(MCP_TOOLS.has(t), t).toBe(false)
  })
  it('no hybrid tool is also a TS-adapter or blocked tool', () => {
    for (const t of HYBRID_TOOLS) {
      expect(MCP_TOOLS.has(t), t).toBe(false)
      expect(MCP_BLOCKED_UNDER_FLAG.has(t), t).toBe(false)
    }
  })
})
