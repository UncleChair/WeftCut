// apps/desktop/src/main/mcp/motifToolDefs.test.ts
// Golden-lock: MOTIF_TOOL_DEFS membership + schema faithfulness vs the frozen snapshot.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MOTIF_TOOL_DEFS } from './motifToolDefs.js'

type SnapshotTool = { name: string; description: string; inputSchema: Record<string, unknown> }
const snap = JSON.parse(
  readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8'),
) as { tools: SnapshotTool[] }
const snapByName = new Map(snap.tools.map((t) => [t.name, t]))

const MCP_MOTIF_NAMES = new Set([
  'list_motifs',
  'get_motif_source',
  'write_motif_draft',
  'install_motif',
  'delete_motif',
])

describe('MOTIF_TOOL_DEFS', () => {
  it('contains exactly the 5 MCP-advertised motif tool names', () => {
    expect(new Set(MOTIF_TOOL_DEFS.map((d) => d.name))).toEqual(MCP_MOTIF_NAMES)
  })

  for (const name of MCP_MOTIF_NAMES) {
    it(`${name}: description and inputSchema deep-equal the frozen snapshot`, () => {
      const def = MOTIF_TOOL_DEFS.find((d) => d.name === name)
      expect(def, `${name} not found in MOTIF_TOOL_DEFS`).toBeDefined()
      const snap = snapByName.get(name)
      expect(snap, `${name} not in snapshot`).toBeDefined()
      expect(def!.description).toEqual(snap!.description)
      expect(def!.inputSchema).toEqual(snap!.inputSchema)
    })
  }
})
