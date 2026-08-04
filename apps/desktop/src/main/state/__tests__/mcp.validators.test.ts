import { describe, it, expect } from 'vitest'
import { parseInterp, parseInterpOpt, parseAnimatedF64, parseRole, parseRgba, parseNum, parseObj, parseEffectPatch, parseMarkerPatch, McpArgError, toolJson } from '../mcp-commands'

describe('parseInterp', () => {
  it('accepts the simple kinds', () => {
    for (const kind of ['Hold', 'Linear', 'EaseIn', 'EaseOut'] as const)
      expect(parseInterp({ kind })).toEqual({ kind })
  })
  it('accepts Bezier with two control points', () => {
    expect(parseInterp({ kind: 'Bezier', p1: [0.42, 0], p2: [0.58, 1] })).toEqual({ kind: 'Bezier', p1: [0.42, 0], p2: [0.58, 1] })
  })
  it('rejects an unknown kind', () => {
    expect(() => parseInterp({ kind: 'bogus' })).toThrow(McpArgError)
  })
  it('rejects Bezier with a malformed control point', () => {
    expect(() => parseInterp({ kind: 'Bezier', p1: [0.42], p2: [0.58, 1] })).toThrow(McpArgError)
  })
  it('rejects non-objects', () => {
    expect(() => parseInterp(42)).toThrow(McpArgError)
  })
})
describe('parseInterpOpt', () => {
  it('passes undefined through', () => { expect(parseInterpOpt(undefined)).toBeUndefined() })
  it('validates a present value', () => { expect(() => parseInterpOpt({ kind: 'nope' })).toThrow(McpArgError) })
})
describe('parseAnimatedF64', () => {
  it('accepts Static', () => { expect(parseAnimatedF64({ mode: 'Static', value: 1 })).toEqual({ mode: 'Static', value: 1 }) })
  it('accepts Keyframed', () => {
    const t = { mode: 'Keyframed', value: [{ id: '00000000-0000-0000-0000-000000000001', t_us: 0, value: 0, interp: { kind: 'Linear' } }] }
    expect(parseAnimatedF64(t)).toEqual(t)
  })
  it('rejects a bad mode', () => { expect(() => parseAnimatedF64({ mode: 'Bogus', value: 1 })).toThrow(McpArgError) })
  it('rejects a keyframe with a bad interp', () => {
    expect(() => parseAnimatedF64({ mode: 'Keyframed', value: [{ id: 'x', t_us: 0, value: 0, interp: { kind: 'no' } }] })).toThrow(McpArgError)
  })
})
describe('parseRole', () => {
  it('accepts the four roles', () => {
    for (const r of ['dialogue', 'music', 'sfx', 'voiceover']) expect(parseRole(r)).toBe(r)
  })
  it('rejects an unknown role', () => { expect(() => parseRole('bogus')).toThrow(McpArgError) })
  it('rejects a non-string', () => { expect(() => parseRole(3)).toThrow(McpArgError) })
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
  // Regression: toolJson must NOT sentinel wall-clock fields. The Rust MCP path
  // (NamedCheckpointSummary etc.) returned real DateTime<Utc> in tool results;
  // reusing the differential-harness canonicalize() leaked '<TS>' to MCP agents
  // (list_checkpoints.created_at, begin_agent_session.started_at).
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
