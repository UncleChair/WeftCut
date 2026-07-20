// apps/desktop/src/main/mcp/motifToolDefs.test.ts
// MOTIF_TOOL_DEFS are TS-owned and are the source of truth for the advertised motif
// surface (the Rust catalog carries no motif arms, so there is no frozen oracle to
// diff against). This locks their exact membership and asserts each def is a
// well-formed, internally-consistent JSON-Schema object — which is what actually
// ships in ListTools.
import { describe, it, expect } from 'vitest'
import { MOTIF_TOOL_DEFS } from './motifToolDefs.js'

const MCP_MOTIF_NAMES = new Set([
  'list_motifs',
  'get_motif_source',
  'write_motif_draft',
  'preview_motif_draft',
  'install_motif',
  'delete_motif',
])

describe('MOTIF_TOOL_DEFS', () => {
  it('contains exactly the 6 MCP-advertised motif tool names', () => {
    expect(new Set(MOTIF_TOOL_DEFS.map((d) => d.name))).toEqual(MCP_MOTIF_NAMES)
  })

  for (const name of MCP_MOTIF_NAMES) {
    it(`${name}: has a non-empty description and a well-formed object inputSchema`, () => {
      const def = MOTIF_TOOL_DEFS.find((d) => d.name === name)
      expect(def, `${name} not found in MOTIF_TOOL_DEFS`).toBeDefined()

      expect(typeof def!.description).toBe('string')
      expect(def!.description.length).toBeGreaterThan(0)

      const schema = def!.inputSchema as {
        type?: unknown
        properties?: Record<string, unknown>
        required?: unknown
      }
      expect(schema.type, `${name}.inputSchema.type`).toBe('object')

      // Internal consistency: every required field must be a declared property —
      // catches a required-name typo or a property that was renamed/dropped.
      const props = schema.properties ?? {}
      const required = schema.required ?? []
      expect(Array.isArray(required)).toBe(true)
      for (const field of required as unknown[]) {
        expect(typeof field, `${name}.required entry`).toBe('string')
        expect(
          Object.prototype.hasOwnProperty.call(props, field as string),
          `${name}: required '${String(field)}' is not a declared property`,
        ).toBe(true)
      }
    })
  }
})
