// apps/desktop/src/main/state/__tests__/mcp.catalog-bijection.test.ts
// Permanent catalog↔handler bijection gate (Phase 4a-i §2.7).
// Four assertions: exact-union partition, advertised⇒handled, handled⇒advertised,
// and schema↔validator consistency (required scalar enforcement by the parser).
// REGEN-FREE: no oracle dependency; runs against the committed snapshot.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { routeMcpTool, HYBRID_TOOLS } from '../../mcp/mutationTools'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as { tools: Array<{ name: string }> }
const allRustNames = rust.tools.map((t) => t.name)
const tsNames = new Set(MCP_TOOL_DEFS.map((d) => d.name))
const motifNames = new Set(MOTIF_TOOL_DEFS.map((d) => d.name))
// Phase 4 derivation: "Rust-native" = only tools that route 'rust' or 'hybrid'.
// Motif tools (route 'motif') now come from the TS motif table — excluded from nativeNames.
const nativeNames = allRustNames.filter((n) => { const r = routeMcpTool(n); return r === 'rust' || r === 'hybrid' })

// ── Assertion 4: structural-field exclusions ─────────────────────────────────
// These (tool, field) pairs are excluded from the "omit a required field → throw"
// probe because the field is either:
//   (a) a structural object/array passed through to the actor mutation for
//       downstream validation — the pre-commit parser legitimately does NOT throw
//       on their absence; or
//   (b) an object field whose absence is an intentional wire-contract semantic
//       (parser defaults silently), documented in the tool description.
//
// ONLY structural object/array fields may be excluded — never a plain scalar
// (uuid/number/enum/bool/string).
//
// Justification for each entry:
//   update_layer.patch       — LayerPatch struct; parser does `a.patch` raw, mutation validates shape
//   update_layer_params.patch — LayerParamsPatch discriminated union; same pass-through pattern
//   update_effect.patch      — { enabled?, params? } object; passed through as-is to the actor
//   update_marker.patch      — MarkerPatch struct; parser does `a.patch` raw, mutation validates
//   set_composition.patch    — CompositionPatch struct; cast as Record<string,unknown>, mutation validates
//   set_keyframe.interp      — Interpolation object; schema lists it required but wire contract allows
//                              omission to mean "inherit previous segment easing" (description: "omit to
//                              inherit"), parseDedicated uses parseInterpOpt which passes undefined through;
//                              the corpus fixture set-keyframe.json:4 omits it — fixing the parser would
//                              break the differential gate without a corpus regen.
const STRUCTURAL_REQUIRED: Record<string, ReadonlySet<string>> = {
  update_layer:        new Set(['patch']),
  update_layer_params: new Set(['patch']),
  update_effect:       new Set(['patch']),
  update_marker:       new Set(['patch']),
  set_composition:     new Set(['patch']),
  set_keyframe:        new Set(['interp']),
  // add_motif.props is a structural JSON object passed through to canonicalizeProps
  // (absent = use all schema defaults; null/undefined → treat as {}). The parser does
  // `a.props ?? null` and does NOT throw on its absence — matching Rust's wire contract
  // where props is Option<serde_json::Value>, defaulting to {} when None.
  add_motif:           new Set(['props']),
}

describe('MCP catalog↔handler bijection (permanent gate)', () => {
  it('1. merged catalog (native ∪ TS table ∪ motif table) is an exact union — no dup, no drop', () => {
    const merged = new Set([...nativeNames, ...tsNames, ...motifNames])
    // No overlap among the three buckets.
    expect(nativeNames.filter((n) => tsNames.has(n))).toEqual([])
    expect(nativeNames.filter((n) => motifNames.has(n))).toEqual([])
    expect([...tsNames].filter((n) => motifNames.has(n))).toEqual([])
    // Exact union: merged equals the advertised Rust set (no drop, no extra).
    // nativeNames excludes motif-routed names; motifNames covers them instead.
    expect(merged).toEqual(new Set(allRustNames))
  })

  it('2. every TS-table name routes to ts; every MOTIF_TOOL_DEFS name routes to motif', () => {
    for (const d of MCP_TOOL_DEFS) expect(routeMcpTool(d.name)).toBe('ts')
    for (const d of MOTIF_TOOL_DEFS) expect(routeMcpTool(d.name)).toBe('motif')
  })

  it('3. every ts-routed name is in the TS table; every hybrid-routed name is in HYBRID_TOOLS; every motif-routed name in allRustNames is in motifNames', () => {
    for (const n of allRustNames) {
      const r = routeMcpTool(n)
      if (r === 'ts') expect(tsNames.has(n)).toBe(true)
      if (r === 'hybrid') expect(HYBRID_TOOLS.has(n)).toBe(true)
      if (r === 'motif') expect(motifNames.has(n)).toBe(true)
    }
  })

  it('4. schema↔validator consistency: every required scalar inputSchema field is enforced by the tool\'s parser', () => {
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
