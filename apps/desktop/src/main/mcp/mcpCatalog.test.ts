import { describe, it, expect } from 'vitest'
import { mergeMcpCatalog } from './mcpCatalog.js'
import { MCP_TOOL_DEFS } from '../state/mcp-commands.js'
import { routeMcpTool } from './mutationTools.js'

describe('mergeMcpCatalog', () => {
  const tsDefs = MCP_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))

  it('is an exact union with no duplicate names (TS tools dropped from the Rust side)', () => {
    // Rust catalog still advertises EVERYTHING in 4a (mutations + native + hybrids).
    const rust = [
      { name: 'list_motifs' }, { name: 'ping' }, { name: 'import_media' }, // native + hybrid (kept)
      { name: 'add_track' }, { name: 'add_motif' },                        // TS-executed (dropped from rust side)
    ]
    const merged = mergeMcpCatalog(rust, tsDefs)
    const names = merged.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)            // no dup
    expect(names).toContain('list_motifs')                    // rust-native kept
    expect(names).toContain('import_media')                   // hybrid kept (route 'hybrid' !== 'ts')
    expect(names).toContain('add_track')                      // ts kept (from TS table)
    expect(names).toContain('add_motif')
  })

  it('every merged name resolves to exactly one engine (no advertised-but-unhandled)', () => {
    const rust = [{ name: 'list_motifs' }, { name: 'ping' }, { name: 'import_media' }, { name: 'add_track' }]
    const merged = mergeMcpCatalog(rust, tsDefs)
    for (const t of merged) expect(['ts', 'rust', 'hybrid', 'motif']).toContain(routeMcpTool(t.name))
  })

  it('advertises the TS table inputSchema for ts-routed tools', () => {
    const rust = [{ name: 'add_track', description: 'RUST DESC', inputSchema: { type: 'object', properties: {} } }]
    const merged = mergeMcpCatalog(rust, tsDefs)
    const addTrack = merged.find((t) => t.name === 'add_track')!
    expect(addTrack.description).not.toBe('RUST DESC')        // TS table wins for ts tools
  })
})
