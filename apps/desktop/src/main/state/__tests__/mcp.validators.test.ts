import { describe, it, expect } from 'vitest'
import { parseInterp, parseInterpOpt, parseAnimatedF64, parseRole, parseRgba, parseNum, McpArgError } from '../mcp-commands'

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
