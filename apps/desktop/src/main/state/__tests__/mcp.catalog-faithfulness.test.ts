// apps/desktop/src/main/state/__tests__/mcp.catalog-faithfulness.test.ts
// Loose faithfulness gate: every TS MCP tool def has the same required-field
// names and top-level property types as the Rust catalog snapshot.
// "Loose" = schemars-specific keys ($schema, title, definitions) are ignored;
// only required names + each property's top-level `type` are asserted.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'

type RustProp = { type?: unknown }
type RustToolSchema = { required?: string[]; properties?: Record<string, RustProp> }
type RustTool = { name: string; inputSchema: RustToolSchema }

const rust = JSON.parse(
  readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8'),
) as { tools: RustTool[] }
const rustByName = new Map(rust.tools.map((t) => [t.name, t]))

describe('TS MCP schemas are faithful to the Rust catalog (loose)', () => {
  for (const def of MCP_TOOL_DEFS) {
    it(`${def.name}: required-field names + types match Rust`, () => {
      const r = rustByName.get(def.name)
      expect(r, `${def.name} missing from Rust catalog`).toBeDefined()
      const ts = def.inputSchema as RustToolSchema
      expect(new Set(ts.required ?? [])).toEqual(new Set(r!.inputSchema.required ?? []))
      for (const [k, v] of Object.entries(r!.inputSchema.properties ?? {})) {
        if (v.type) {
          expect(
            ts.properties?.[k]?.type,
            `${def.name}.${k} type`,
          ).toEqual(v.type)
        }
      }
    })
  }

  for (const def of MOTIF_TOOL_DEFS) {
    it(`motif/${def.name}: required-field names + types match Rust snapshot`, () => {
      const r = rustByName.get(def.name)
      expect(r, `${def.name} missing from Rust catalog snapshot`).toBeDefined()
      const ts = def.inputSchema as RustToolSchema
      expect(new Set(ts.required ?? [])).toEqual(new Set(r!.inputSchema.required ?? []))
      for (const [k, v] of Object.entries(r!.inputSchema.properties ?? {})) {
        if (v.type) {
          expect(
            ts.properties?.[k]?.type,
            `${def.name}.${k} type`,
          ).toEqual(v.type)
        }
      }
    })
  }
})
