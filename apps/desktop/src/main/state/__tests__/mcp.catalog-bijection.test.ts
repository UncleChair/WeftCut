// apps/desktop/src/main/state/__tests__/mcp.catalog-bijection.test.ts
// Permanent catalog↔handler bijection gate.
//
// Asserts the LIVE merged MCP catalog — mergeMcpCatalog(rust-native snapshot,
// [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS]), exactly what server.ts advertises via
// ListTools — is a clean, disjoint union where every advertised tool routes to a
// bucket that actually serves it, and every required scalar is enforced by its parser.
//
// The Rust snapshot is the LIVE rust-native surface ONLY: ping, the clip compute
// tools (detect_silences, transcribe_clip, analyze_clip, compare_frames,
// describe_clip), and the hybrid-import tools (import_media, apply_subtitles,
// synthesize_speech). The mutation defs (MCP_TOOL_DEFS) and the motif defs are
// TS-owned — TS is their source of truth, so there is nothing for them to "be
// faithful to". Because the snapshot == what the addon advertises,
// snapshot ∪ TS tables == the exact runtime catalog, so these assertions describe what
// actually ships. Rust-side schema drift is guarded by regenerating the fixture
// (`node scripts/snapshot-mcp-catalog.mjs`) and diffing — not by this suite, which
// stays REGEN-FREE (no napi-addon dependency at test time).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { routeMcpTool, HYBRID_TOOLS } from '../../mcp/mutationTools'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { mergeMcpCatalog } from '../../mcp/mcpCatalog'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string }>
}
const rustNames = new Set(rust.tools.map((t) => t.name))
const tsNames = new Set(MCP_TOOL_DEFS.map((d) => d.name))
const motifNames = new Set(MOTIF_TOOL_DEFS.map((d) => d.name))

// The catalog the MCP host actually advertises at runtime (server.ts ListTools).
const merged = mergeMcpCatalog(rust.tools, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS])
const mergedNames = merged.map((t) => t.name)

// ── Assertion 6: structural-field exclusions ─────────────────────────────────
// (tool, field) pairs excluded from the "omit a required field → throw" probe.
// Empty: every required `patch` goes through a parse gate (parseObj at
// minimum — a missing/non-object patch throws instead of committing nothing and
// reporting success), and the two fields whose omission IS the wire contract
// (set_keyframe.interp = inherit previous easing, add_motif.props = all
// defaults) are absent from the schema `required` lists so the advertised
// contract matches the parser. New entries need the same bar:
// ONLY a structural object/array field whose omission is a documented semantic
// may go here — never a plain scalar.
const STRUCTURAL_REQUIRED: Record<string, ReadonlySet<string>> = {}

describe('MCP catalog↔handler bijection (permanent gate)', () => {
  it('1. the three ownership buckets are pairwise disjoint (no double source of truth)', () => {
    // A name claimed by both the live Rust catalog and a TS table would be silently
    // dropped by mergeMcpCatalog (dedup by name), hiding which engine truly owns it.
    expect([...rustNames].filter((n) => tsNames.has(n))).toEqual([])
    expect([...rustNames].filter((n) => motifNames.has(n))).toEqual([])
    expect([...tsNames].filter((n) => motifNames.has(n))).toEqual([])
  })

  it('2. the merged catalog is an exact, duplicate-free union of the three buckets', () => {
    expect(new Set(mergedNames)).toEqual(new Set([...rustNames, ...tsNames, ...motifNames]))
    // Disjoint (assertion 1) ⇒ nothing dropped, so the count is the plain sum.
    expect(mergedNames.length).toBe(rustNames.size + tsNames.size + motifNames.size)
    expect(new Set(mergedNames).size).toBe(mergedNames.length) // no duplicate names
  })

  it('3. every advertised tool routes to a bucket that actually serves it', () => {
    for (const n of mergedNames) {
      const r = routeMcpTool(n)
      if (r === 'ts') expect(tsNames.has(n), n).toBe(true)
      else if (r === 'hybrid') expect(HYBRID_TOOLS.has(n), n).toBe(true)
      else if (r === 'motif') expect(motifNames.has(n), n).toBe(true)
      else {
        // route 'rust' = backend-dispatched (present in the live snapshot) OR
        // preview_motif_draft, whose def is TS-sourced but whose execution is the
        // CDP-capture special-case in server.ts rather than the backend catalog.
        expect(
          rustNames.has(n) || n === 'preview_motif_draft',
          `${n} routes 'rust' but is neither in the live Rust snapshot nor the preview capture special-case`,
        ).toBe(true)
      }
    }
  })

  it('4. every TS def routes ts (hybrid for TS-owned hybrid defs); every motif def routes motif except preview_motif_draft (rust capture)', () => {
    // A TS def normally routes 'ts'; a TS-owned HYBRID def (auto_split_by_shot)
    // routes 'hybrid' — HYBRID_TOOLS is consulted before MCP_TOOLS, because its
    // cuts compute in Rust while its splits write through the TS actor.
    for (const d of MCP_TOOL_DEFS) expect(routeMcpTool(d.name), d.name).toBe(HYBRID_TOOLS.has(d.name) ? 'hybrid' : 'ts')
    for (const d of MOTIF_TOOL_DEFS) {
      // preview_motif_draft is the one motif DEF whose EXECUTION is not the motif-store
      // route: it is served by the CDP-capture special-case in server.ts, so it routes
      // 'rust'. Its def still lives in MOTIF_TOOL_DEFS. The others route to the motif store.
      if (d.name === 'preview_motif_draft') expect(routeMcpTool(d.name)).toBe('rust')
      else expect(routeMcpTool(d.name), d.name).toBe('motif')
    }
  })

  it('5. every rust-native snapshot tool routes to rust or hybrid (never a TS engine)', () => {
    // The snapshot is the surface the backend owns; none of it may be claimed by a TS
    // engine.
    for (const n of rustNames) expect(['rust', 'hybrid'], n).toContain(routeMcpTool(n))
  })

  it("6. schema↔validator consistency: every required scalar inputSchema field is enforced by the tool's parser", () => {
    for (const d of MCP_TOOL_DEFS) {
      const required = ((d.inputSchema as { required?: string[] }).required) ?? []
      const parse = d.parseArgs ?? d.parseDedicated
      if (!parse) continue
      const excluded = STRUCTURAL_REQUIRED[d.name] ?? new Set<string>()

      for (const field of required) {
        if (excluded.has(field)) continue
        // Build args with all OTHER required fields present (valid values) and
        // the probed field omitted. A compliant parser must throw — omitting a
        // required scalar is invalid input.
        const args: Record<string, unknown> = {}
        for (const r of required) {
          if (r !== field) args[r] = sampleFor(d.name, r)
        }
        expect(
          () => parse(args),
          `${d.name}: missing required '${field}' should reject`,
        ).toThrow()
      }
    }
  })

  it('7. every advertised property carries a type (untyped fields get string-coerced by MCP clients)', () => {
    // Root finding of .scratch/mcp-agent-hardening: a property advertised as
    // `{}` (or description-only) is rewritten to `type: string` by the Claude
    // Code MCP client layer, CONSTRAINING the model to emit the payload as a
    // JSON-encoded string no matter the prompt. The server then rejects — or
    // silently ignores — it. Typing every field at the source is the only fix.
    const untyped: string[] = []
    const typed = (s: Record<string, unknown>): boolean =>
      'type' in s || 'enum' in s || 'const' in s || '$ref' in s || 'oneOf' in s || 'anyOf' in s || 'allOf' in s
    const walk = (schema: unknown, path: string): void => {
      if (schema === null || typeof schema !== 'object') return
      const s = schema as Record<string, unknown>
      const props = s.properties as Record<string, unknown> | undefined
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (v === null || typeof v !== 'object' || !typed(v as Record<string, unknown>)) untyped.push(`${path}.${k}`)
          walk(v, `${path}.${k}`)
        }
      }
      if (s.items) walk(s.items, `${path}[]`)
      if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${path}.*`)
      for (const alt of ['oneOf', 'anyOf', 'allOf'] as const) {
        const list = s[alt]
        if (Array.isArray(list)) list.forEach((v, i) => walk(v, `${path}<${alt}[${i}]>`))
      }
    }
    for (const t of merged) walk(t.inputSchema, t.name)
    expect(untyped).toEqual([])
  })
})

// sampleFor: minimal valid value per (tool, field) so the "omit one required"
// probe isolates the missing field. Keyed first by (tool, field) for narrow
// overrides, then by field-name convention.
function sampleFor(tool: string, field: string): unknown {
  // per-tool narrow overrides — MUST precede the field-name conventions so they
  // are not shadowed. set_param_track's `track` is an Animated<number>, not a
  // uuid; the uuid fallback below would otherwise make parseAnimatedF64 throw on
  // a uuid string regardless of which field is omitted, so the probe would pass
  // for the wrong reason and stop isolating the omitted field.
  if (tool === 'set_keyframe' && field === 'interp') return { kind: 'Linear' }
  if (tool === 'set_keyframe_easing' && field === 'interp') return { kind: 'Linear' }
  if (tool === 'set_param_track' && field === 'track') return { mode: 'Static', value: 0 }
  // patch parsers are strict since the mcp-agent-hardening pass: the string
  // fallback below would make them throw regardless of which field is omitted,
  // so the probe would pass for the wrong reason. {} is valid for every one.
  if (field === 'patch') return {}

  // field-name convention defaults
  if (field.endsWith('_id') || field === 'group' || field === 'layer') {
    return '00000000-0000-7000-8000-000000000001'
  }
  if (field.endsWith('_us') || field === 'gain_db' || field === 'value') return 0
  if (field === 'role') return 'music'
  if (field === 'color') return { r: 0, g: 0, b: 0, a: 255 }
  if (field === 'operations') return []
  if (field === 'layer_ids') return ['00000000-0000-7000-8000-000000000001']
  if (field === 'new_position') return 0
  if (field === 'new_index') return 0
  if (field === 'edge') return 'in'
  if (field === 'kind') return 'blur'
  if (field === 'param_key') return 'opacity'
  return 'x'
}
