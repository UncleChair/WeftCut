import { describe, it, expect } from 'vitest'
import { parseInterp, parseInterpOpt, parseEasing, parseAnimatedF64, parseRole, parseRgba, parseNum, parseObj, parseEffectPatch, parseMarkerPatch, parseTransitionPlacement, McpArgError, toolJson } from '../mcp-commands'
import { EASING_PRESETS } from '../../../shared/easing'

describe('parseInterp', () => {
  it('accepts Hold and Linear', () => {
    for (const kind of ['Hold', 'Linear'] as const)
      expect(parseInterp({ kind })).toEqual({ kind })
  })
  it('accepts Bezier with two in-range control points', () => {
    expect(parseInterp({ kind: 'Bezier', p1: [0.42, 0], p2: [0.58, 1] })).toEqual({ kind: 'Bezier', p1: [0.42, 0], p2: [0.58, 1] })
  })
  it('accepts Bezier y overshoot (only x is range-gated)', () => {
    expect(parseInterp({ kind: 'Bezier', p1: [1 / 3, 1.567], p2: [2 / 3, -0.5] }))
      .toEqual({ kind: 'Bezier', p1: [1 / 3, 1.567], p2: [2 / 3, -0.5] })
  })
  it('accepts Elastic with explicit dir/amplitude/period', () => {
    expect(parseInterp({ kind: 'Elastic', dir: 'InOut', amplitude: 1.5, period: 0.45 }))
      .toEqual({ kind: 'Elastic', dir: 'InOut', amplitude: 1.5, period: 0.45 })
  })
  it('backfills omitted Elastic amplitude/period with the shared defaults', () => {
    expect(parseInterp({ kind: 'Elastic', dir: 'Out' }))
      .toEqual({ kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.3 })
  })
  it('accepts Bounce with each dir', () => {
    for (const dir of ['In', 'Out', 'InOut'] as const)
      expect(parseInterp({ kind: 'Bounce', dir })).toEqual({ kind: 'Bounce', dir })
  })
  it('rejects EaseIn/EaseOut pointing at the preset replacement and the live kinds', () => {
    expect(() => parseInterp({ kind: 'EaseIn' })).toThrow(/"preset":"ease_in"/)
    expect(() => parseInterp({ kind: 'EaseOut' })).toThrow(/"preset":"ease_out"/)
    expect(() => parseInterp({ kind: 'EaseIn' })).toThrow(/'Hold' \| 'Linear' \| 'Bezier' \| 'Elastic' \| 'Bounce'/)
  })
  it('rejects an unknown kind naming the live kinds', () => {
    expect(() => parseInterp({ kind: 'bogus' })).toThrow(/'Hold' \| 'Linear' \| 'Bezier' \| 'Elastic' \| 'Bounce'/)
  })
  it('rejects Bezier with a malformed control point', () => {
    expect(() => parseInterp({ kind: 'Bezier', p1: [0.42], p2: [0.58, 1] })).toThrow(McpArgError)
  })
  it('rejects Bezier control-point x outside [0, 1] on either handle, naming the handle', () => {
    expect(() => parseInterp({ kind: 'Bezier', p1: [-0.1, 0], p2: [0.58, 1] })).toThrow(/p1\[0\].*within \[0, 1\]/)
    expect(() => parseInterp({ kind: 'Bezier', p1: [0.42, 0], p2: [1.2, 1] })).toThrow(/p2\[0\].*within \[0, 1\]/)
    expect(() => parseInterp({ kind: 'Bezier', p1: [NaN, 0], p2: [0.58, 1] })).toThrow(McpArgError)
  })
  it('rejects Elastic amplitude below 1 and period at or below 0, naming the defaults', () => {
    expect(() => parseInterp({ kind: 'Elastic', dir: 'Out', amplitude: 0.5 })).toThrow(/amplitude must be >= 1.*default 1/)
    expect(() => parseInterp({ kind: 'Elastic', dir: 'Out', period: 0 })).toThrow(/period must be > 0.*default 0\.3/)
    expect(() => parseInterp({ kind: 'Elastic', dir: 'Out', period: -0.3 })).toThrow(McpArgError)
    expect(() => parseInterp({ kind: 'Elastic', dir: 'Out', amplitude: 'big' })).toThrow(McpArgError)
  })
  it('rejects Elastic/Bounce without a valid dir, naming the three options', () => {
    expect(() => parseInterp({ kind: 'Elastic' })).toThrow(/'In' \| 'Out' \| 'InOut'/)
    expect(() => parseInterp({ kind: 'Bounce', dir: 'Sideways' })).toThrow(/'In' \| 'Out' \| 'InOut'/)
  })
  it('rejects a preset payload here, pointing at set_keyframe_easing', () => {
    expect(() => parseInterp({ preset: 'ease_in_out' })).toThrow(/set_keyframe_easing/)
  })
  it('rejects non-objects', () => {
    expect(() => parseInterp(42)).toThrow(McpArgError)
  })
})
describe('parseInterpOpt', () => {
  it('passes undefined through', () => { expect(parseInterpOpt(undefined)).toBeUndefined() })
  it('validates a present value', () => { expect(() => parseInterpOpt({ kind: 'nope' })).toThrow(McpArgError) })
})
describe('parseEasing', () => {
  it('bakes every table preset id to a fresh copy of its canonical interp', () => {
    for (const p of EASING_PRESETS) {
      const out = parseEasing({ preset: p.id })
      expect(out, p.id).toEqual(p.interp)
      expect(out, p.id).not.toBe(p.interp) // a table entry must never alias into a track
    }
  })
  it('baked Bezier handles are fresh arrays, not table references', () => {
    const out = parseEasing({ preset: 'ease_in_out' })
    const table = EASING_PRESETS.find((p) => p.id === 'ease_in_out')!.interp
    if (out.kind !== 'Bezier' || table.kind !== 'Bezier') throw new Error('ease_in_out must be a Bezier preset')
    expect(out.p1).not.toBe(table.p1)
    expect(out.p2).not.toBe(table.p2)
  })
  it('accepts each raw kind (delegates to parseInterp, defaults included)', () => {
    expect(parseEasing({ kind: 'Hold' })).toEqual({ kind: 'Hold' })
    expect(parseEasing({ kind: 'Linear' })).toEqual({ kind: 'Linear' })
    expect(parseEasing({ kind: 'Bezier', p1: [0.2, -0.5], p2: [0.8, 1.5] })).toEqual({ kind: 'Bezier', p1: [0.2, -0.5], p2: [0.8, 1.5] })
    expect(parseEasing({ kind: 'Elastic', dir: 'In' })).toEqual({ kind: 'Elastic', dir: 'In', amplitude: 1, period: 0.3 })
    expect(parseEasing({ kind: 'Bounce', dir: 'InOut' })).toEqual({ kind: 'Bounce', dir: 'InOut' })
  })
  it('rejects an unknown preset id with the live id list in the message', () => {
    expect(() => parseEasing({ preset: 'ease_in_bogus' })).toThrow(/unknown preset 'ease_in_bogus' — presets: linear, hold, ease,/)
    expect(() => parseEasing({ preset: 'ease_in_bogus' })).toThrow(/ease_in_out_bounce/)
  })
  it('rejects preset and kind together (ambiguous)', () => {
    expect(() => parseEasing({ preset: 'linear', kind: 'Linear' })).toThrow(/not both/)
  })
  it('rejects an object with neither form, naming both', () => {
    expect(() => parseEasing({})).toThrow(/\{"preset":"<id>"\} or a raw kind/)
  })
  it('rejects the retired named-ease kinds (same message as parseInterp)', () => {
    expect(() => parseEasing({ kind: 'EaseIn' })).toThrow(/"preset":"ease_in"/)
  })
  it('rejects non-objects', () => { expect(() => parseEasing(null)).toThrow(McpArgError) })
})
describe('parseAnimatedF64', () => {
  it('accepts Static', () => { expect(parseAnimatedF64({ mode: 'Static', value: 1 })).toEqual({ mode: 'Static', value: 1 }) })
  it('accepts Keyframed', () => {
    const t = { mode: 'Keyframed', value: [{ id: '00000000-0000-0000-0000-000000000001', t_us: 0, value: 0, interp: { kind: 'Linear' } }] }
    expect(parseAnimatedF64(t)).toEqual(t)
  })
  it('accepts Keyframed keys carrying the procedural kinds (Elastic defaults backfilled)', () => {
    const t = { mode: 'Keyframed', value: [
      { id: '00000000-0000-0000-0000-000000000001', t_us: 0, value: 0, interp: { kind: 'Elastic', dir: 'Out' } },
      { id: '00000000-0000-0000-0000-000000000002', t_us: 1, value: 1, interp: { kind: 'Bounce', dir: 'In' } },
    ] }
    const parsed = parseAnimatedF64(t) as { value: Array<{ interp: unknown }> }
    expect(parsed.value[0].interp).toEqual({ kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.3 })
    expect(parsed.value[1].interp).toEqual({ kind: 'Bounce', dir: 'In' })
  })
  it('rejects a bad mode', () => { expect(() => parseAnimatedF64({ mode: 'Bogus', value: 1 })).toThrow(McpArgError) })
  it('rejects a keyframe with a bad interp', () => {
    expect(() => parseAnimatedF64({ mode: 'Keyframed', value: [{ id: 'x', t_us: 0, value: 0, interp: { kind: 'no' } }] })).toThrow(McpArgError)
  })
  it('rejects a keyframe with the retired EaseIn interp', () => {
    expect(() => parseAnimatedF64({ mode: 'Keyframed', value: [{ id: 'x', t_us: 0, value: 0, interp: { kind: 'EaseIn' } }] })).toThrow(McpArgError)
  })
})
describe('parseRole', () => {
  it('accepts the four roles', () => {
    for (const r of ['dialogue', 'music', 'sfx', 'voiceover']) expect(parseRole(r)).toBe(r)
  })
  it('rejects an unknown role', () => { expect(() => parseRole('bogus')).toThrow(McpArgError) })
  it('rejects a non-string', () => { expect(() => parseRole(3)).toThrow(McpArgError) })
})
describe('parseTransitionPlacement', () => {
  it("absent (undefined/null) defaults to 'overlap' — spec D1", () => {
    expect(parseTransitionPlacement(undefined)).toBe('overlap')
    expect(parseTransitionPlacement(null)).toBe('overlap')
  })
  it('accepts the two placements', () => {
    expect(parseTransitionPlacement('overlap')).toBe('overlap')
    expect(parseTransitionPlacement('extend')).toBe('extend')
  })
  it('rejects a typo instead of silently classifying as overlap', () => {
    expect(() => parseTransitionPlacement('Extend')).toThrow(McpArgError)
    expect(() => parseTransitionPlacement('both')).toThrow(McpArgError)
    expect(() => parseTransitionPlacement(1)).toThrow(McpArgError)
  })
})

describe('parseRgba', () => {
  it('accepts a well-formed Rgba object', () => {
    expect(parseRgba({ r: 0, g: 128, b: 255, a: 255 }, 'color')).toEqual({ r: 0, g: 128, b: 255, a: 255 })
  })
  it('accepts alpha as a small integer (e.g. a:1)', () => {
    expect(parseRgba({ r: 0, g: 0, b: 0, a: 1 }, 'color')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
  })
  it('rejects a hex string', () => { expect(() => parseRgba('#fff', 'color')).toThrow(McpArgError) })
  it('rejects a missing component', () => { expect(() => parseRgba({ r: 0, g: 0, b: 0 }, 'color')).toThrow(McpArgError) })
  it('rejects an out-of-range component', () => { expect(() => parseRgba({ r: 0, g: 0, b: 0, a: 256 }, 'color')).toThrow(McpArgError) })
  it('rejects a non-integer component', () => { expect(() => parseRgba({ r: 0.5, g: 0, b: 0, a: 1 }, 'color')).toThrow(McpArgError) })
  it('rejects null / non-object', () => {
    expect(() => parseRgba(null, 'color')).toThrow(McpArgError)
    expect(() => parseRgba(42, 'color')).toThrow(McpArgError)
  })
})
describe('parseNum', () => {
  it('accepts finite numbers incl. negatives and zero', () => {
    expect(parseNum(0, 't_us')).toBe(0)
    expect(parseNum(1_000_000, 't_us')).toBe(1_000_000)
    expect(parseNum(-5, 't_us')).toBe(-5)
  })
  it('rejects a string', () => { expect(() => parseNum('abc', 't_us')).toThrow(McpArgError) })
  it('rejects NaN / Infinity', () => {
    expect(() => parseNum(NaN, 't_us')).toThrow(McpArgError)
    expect(() => parseNum(Infinity, 't_us')).toThrow(McpArgError)
  })
  it('rejects undefined / null', () => {
    expect(() => parseNum(undefined, 't_us')).toThrow(McpArgError)
    expect(() => parseNum(null, 't_us')).toThrow(McpArgError)
  })
})

describe('parseObj', () => {
  it('passes a plain object through', () => { expect(parseObj({ a: 1 }, 'patch')).toEqual({ a: 1 }) })
  it('rejects a JSON-encoded string (the string-coerced-client shape)', () => {
    expect(() => parseObj('{"a":1}', 'patch')).toThrow(McpArgError)
  })
  it('rejects null, arrays, and undefined', () => {
    expect(() => parseObj(null, 'patch')).toThrow(McpArgError)
    expect(() => parseObj([1], 'patch')).toThrow(McpArgError)
    expect(() => parseObj(undefined, 'patch')).toThrow(McpArgError)
  })
})

describe('parseEffectPatch', () => {
  it('accepts { enabled, params } with AnimTrack values', () => {
    expect(parseEffectPatch({ enabled: true, params: { strength: { mode: 'Static', value: 8 } } }))
      .toEqual({ enabled: true, params: { strength: { mode: 'Static', value: 8 } } })
  })
  it('accepts an empty patch (no-op, but honestly so)', () => { expect(parseEffectPatch({})).toEqual({}) })
  it('null enabled/params mean "don\'t touch" and are dropped', () => {
    expect(parseEffectPatch({ enabled: null, params: null })).toEqual({})
  })
  it('rejects a string patch with the expected-shape hint', () => {
    expect(() => parseEffectPatch('{"enabled":true}')).toThrow(/JSON object/)
  })
  it('rejects unknown keys naming the key', () => {
    expect(() => parseEffectPatch({ paramz: {} })).toThrow(/unknown key 'paramz'/)
  })
  it('rejects a non-boolean enabled', () => {
    expect(() => parseEffectPatch({ enabled: 'yes' })).toThrow(McpArgError)
  })
  it('rejects a malformed param value naming the param', () => {
    expect(() => parseEffectPatch({ params: { strength: 8 } })).toThrow(/params\['strength'\]/)
  })
})

describe('parseMarkerPatch', () => {
  it('accepts a full valid patch', () => {
    const p = { t_us: 1, end_t_us: 2, label: 'x', color: { r: 0, g: 0, b: 0, a: 255 } }
    expect(parseMarkerPatch(p)).toEqual(p)
  })
  it('rejects a string patch', () => { expect(() => parseMarkerPatch('t_us=1')).toThrow(McpArgError) })
  it('rejects unknown keys', () => { expect(() => parseMarkerPatch({ time_us: 1 })).toThrow(/unknown key 'time_us'/) })
  it('rejects wrong-typed fields that applyUpdateMarker would silently skip', () => {
    expect(() => parseMarkerPatch({ t_us: 'now' })).toThrow(McpArgError)
    expect(() => parseMarkerPatch({ label: 5 })).toThrow(McpArgError)
    expect(() => parseMarkerPatch({ color: '#fff' })).toThrow(McpArgError)
  })
})

describe('toolJson', () => {
  const text = (r: ReturnType<typeof toolJson>) => (r.content[0] as { type: 'text'; text: string }).text
  // Regression: toolJson must NOT sentinel wall-clock fields — list_checkpoints
  // .created_at and begin_agent_session.started_at are real timestamps agents read.
  it('preserves real wall-clock timestamps (does not emit the <TS> sentinel)', () => {
    const out = toolJson([{ id: 'x', label: 'cp', actor: { client: 'mcp', kind: 'Agent' }, created_at: '2026-06-26T07:42:46.605Z' }])
    const parsed = JSON.parse(text(out)) as Array<{ created_at: string }>
    expect(parsed[0].created_at).toBe('2026-06-26T07:42:46.605Z')
  })
  it('still sorts object keys recursively (Rust serde_json BTreeMap parity)', () => {
    expect(text(toolJson({ b: 1, a: { d: 2, c: 3 } }))).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
  it('leaves array order intact (order is semantic for tracks/layers/keyframes)', () => {
    expect(text(toolJson({ list: [3, 1, 2] }))).toBe('{"list":[3,1,2]}')
  })
})
