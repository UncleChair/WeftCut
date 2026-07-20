import { describe, it, expect } from 'vitest'
import { routeMcpTool, HYBRID_TOOLS, MOTIF_TOOLS } from './mutationTools'
import { MCP_TOOLS, MCP_TOOL_DEFS } from '../state/mcp-commands'
import { mergeMcpCatalog } from './mcpCatalog'
import { MOTIF_TOOL_DEFS } from './motifToolDefs'

describe('routeMcpTool', () => {
  it('routes ported mutations + reads to ts', () => {
    for (const t of ['add_color_layer', 'set_keyframe', 'undo', 'get_param_track', 'list_checkpoints', 'dry_run'])
      expect(routeMcpTool(t), t).toBe('ts')
  })
  it('routes import_media + apply_subtitles + synthesize_speech to the native-compute → TS-write hybrid', () => {
    expect(routeMcpTool('import_media')).toBe('hybrid')
    expect(routeMcpTool('apply_subtitles')).toBe('hybrid')
    expect(routeMcpTool('synthesize_speech')).toBe('hybrid')
  })
  it('add_motif routes to ts (pure TS mutation, Phase 4a-ii §2.2)', () => {
    expect(routeMcpTool('add_motif')).toBe('ts')
  })
  it('routes the 5 MCP motif tools to the motif route (Phase 2)', () => {
    for (const t of ['list_motifs', 'get_motif_source', 'write_motif_draft', 'delete_motif', 'install_motif'])
      expect(routeMcpTool(t), t).toBe('motif')
  })
  it('routes motif_staleness_report and acknowledge_motif_staleness to the motif route (Phase 3)', () => {
    expect(routeMcpTool('motif_staleness_report')).toBe('motif')
    expect(routeMcpTool('acknowledge_motif_staleness')).toBe('motif')
  })
  it('preview_motif_draft stays rust (special-cased capture in server.ts)', () => {
    expect(routeMcpTool('preview_motif_draft')).toBe('rust')
  })
  it('routes the live rust-native tools to rust', () => {
    // groups_list / groups_get are gone: group reads now come from the project
    // summary resource (project://current includes `groups`), not an MCP tool.
    for (const t of ['ping', 'detect_silences', 'transcribe_clip'])
      expect(routeMcpTool(t), t).toBe('rust')
  })
  it('single-writer invariant: every TS-adapter tool routes to ts, never rust', () => {
    for (const t of MCP_TOOLS) expect(routeMcpTool(t), t).toBe('ts')
  })
  it('no hybrid tool is also a TS-adapter tool', () => {
    for (const t of HYBRID_TOOLS) {
      expect(MCP_TOOLS.has(t), t).toBe(false)
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
     { name: 'install_motif' }, { name: 'motif_staleness_report' }, { name: 'acknowledge_motif_staleness' }, { name: 'synthesize_speech' }],
  )
  const tsDefs = MCP_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  const motifDefs = MOTIF_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  const merged = mergeMcpCatalog(rust4a, [...tsDefs, ...motifDefs])

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
      if (r === 'motif') expect(MOTIF_TOOLS.has(t.name)).toBe(true)
    }
  })
})
