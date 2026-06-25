import { describe, it, expect } from 'vitest'
import { parseInterp, parseInterpOpt, parseAnimatedF64, McpArgError } from '../mcp-commands'

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
