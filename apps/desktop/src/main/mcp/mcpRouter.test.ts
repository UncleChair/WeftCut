import { describe, it, expect } from 'vitest'
import { routeMcpTool, MCP_BLOCKED_UNDER_FLAG, HYBRID_TOOLS } from './mutationTools'
import { MCP_TOOLS, MCP_TOOL_DEFS } from '../state/mcp-commands'
import { mergeMcpCatalog } from './mcpCatalog'

describe('routeMcpTool', () => {
  it('routes ported mutations + reads to ts', () => {
    for (const t of ['add_color_layer', 'set_keyframe', 'undo', 'get_param_track', 'list_checkpoints', 'dry_run'])
      expect(routeMcpTool(t), t).toBe('ts')
  })
  it('routes import_media + apply_subtitles + install_motif + acknowledge_motif_staleness + synthesize_speech to the native-compute → TS-write hybrid', () => {
    expect(routeMcpTool('import_media')).toBe('hybrid')
    expect(routeMcpTool('apply_subtitles')).toBe('hybrid')
    expect(routeMcpTool('install_motif')).toBe('hybrid')
    expect(routeMcpTool('acknowledge_motif_staleness')).toBe('hybrid')
    expect(routeMcpTool('synthesize_speech')).toBe('hybrid')
  })
  it('add_motif routes to ts (pure TS mutation, Phase 4a-ii §2.2; MCP_BLOCKED_UNDER_FLAG ∅)', () => {
    expect(routeMcpTool('add_motif')).toBe('ts')
    expect(MCP_BLOCKED_UNDER_FLAG.size).toBe(0)
  })
  it('routes reads + native-read tools to rust (including motif_staleness_report)', () => {
    for (const t of ['groups_list', 'groups_get', 'ping', 'list_motifs', 'get_motif_source', 'preview_motif_draft', 'detect_silences', 'transcribe_clip', 'motif_staleness_report'])
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

describe('merged ListTools is a clean catalog↔handler bijection', () => {
  // Simulate the Rust-advertised set: in 4a it still includes the TS-executed
  // names; in 4b it is the post-split native+hybrid set. Either way the merge
  // must be a duplicate-free union where every name routes to exactly one engine.
  const rust4a = [...MCP_TOOLS].map((n) => ({ name: n })).concat(
    [{ name: 'ping' }, { name: 'list_motifs' }, { name: 'get_motif_source' }, { name: 'preview_motif_draft' },
     { name: 'detect_silences' }, { name: 'transcribe_clip' }, { name: 'import_media' }, { name: 'apply_subtitles' },
     { name: 'install_motif' }, { name: 'acknowledge_motif_staleness' }, { name: 'synthesize_speech' }],
  )
  const tsDefs = MCP_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  const merged = mergeMcpCatalog(rust4a, tsDefs)

  it('no duplicate names', () => {
    const names = merged.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
  it('no advertised-but-unhandled / handled-but-unadvertised', () => {
    const advertised = new Set(merged.map((t) => t.name))
    for (const n of MCP_TOOLS) expect(advertised.has(n)).toBe(true)   // every ts tool advertised
    for (const t of merged) {
      const r = routeMcpTool(t.name)
      if (r === 'ts') expect(MCP_TOOLS.has(t.name)).toBe(true)
      if (r === 'hybrid') expect(HYBRID_TOOLS.has(t.name)).toBe(true)
    }
  })
})
