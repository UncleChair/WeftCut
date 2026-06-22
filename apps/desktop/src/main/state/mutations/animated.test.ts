import { describe, it, expect } from 'vitest'
import type { Animated, LayerParams } from '../model'
import {
  forEachAnimatedF64, forEachAnimatedRgba, shiftKeyframes, retainKeyframes,
  firstKeyframeValue, lastKeyframeValue, collapseToStatic,
} from './animated'

function kf<T>(id: string, t: number, v: T): { id: string; t_us: number; value: T; interp: { kind: 'Linear' } } {
  return { id, t_us: t, value: v, interp: { kind: 'Linear' } }
}

describe('animated traversal', () => {
  it('shiftKeyframes shifts Keyframed, no-ops Static', () => {
    const a: Animated<number> = { mode: 'Keyframed', value: [kf('k', 100, 1), kf('k2', 200, 2)] }
    shiftKeyframes(a, -50)
    expect((a as any).value.map((k: any) => k.t_us)).toEqual([50, 150])
    const s: Animated<number> = { mode: 'Static', value: 5 }
    shiftKeyframes(s, 99); expect(s).toEqual({ mode: 'Static', value: 5 })
  })

  it('retainKeyframes filters by t_us', () => {
    const a: Animated<number> = { mode: 'Keyframed', value: [kf('a', 0, 1), kf('b', 100, 2), kf('c', 200, 3)] }
    retainKeyframes(a, (t) => t > 50)
    expect((a as any).value.map((k: any) => k.t_us)).toEqual([100, 200])
  })

  it('first/last keyframe value: Static→value, Keyframed→ends, empty→null', () => {
    expect(firstKeyframeValue({ mode: 'Static', value: 7 })).toBe(7)
    expect(lastKeyframeValue({ mode: 'Static', value: 7 })).toBe(7)
    const a: Animated<number> = { mode: 'Keyframed', value: [kf('a', 0, 1), kf('b', 100, 2)] }
    expect(firstKeyframeValue(a)).toBe(1); expect(lastKeyframeValue(a)).toBe(2)
    const e: Animated<number> = { mode: 'Keyframed', value: [] }
    expect(firstKeyframeValue(e)).toBeNull(); expect(lastKeyframeValue(e)).toBeNull()
  })

  it('collapseToStatic rewrites mode + value in place', () => {
    const a: Animated<number> = { mode: 'Keyframed', value: [] }
    collapseToStatic(a, 42)
    expect(a).toEqual({ mode: 'Static', value: 42 })
  })

  it('forEachAnimatedF64 visits opacity + 5 transform tracks on Text, none on Color', () => {
    const text: LayerParams = {
      kind: 'Text', content: 'x', font: {} as any, color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } },
      align: 'left' as any,
      transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor: [0, 0] } as any,
      opacity: { mode: 'Static', value: 1 }, shadow: null, outline: null,
      intro: null, outro: null, backend_hint: 'Auto',
    }
    let n = 0; forEachAnimatedF64(text, () => { n++ }); expect(n).toBe(6) // opacity + x,y,sx,sy,rot
    const color: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
    let m = 0; forEachAnimatedF64(color, () => { m++ }); expect(m).toBe(0)
  })

  it('forEachAnimatedRgba visits color on Color/Text, none on Audio', () => {
    const color: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 1, g: 2, b: 3, a: 4 } }, width: 1, height: 1 }
    let n = 0; forEachAnimatedRgba(color, () => { n++ }); expect(n).toBe(1)
    const audio: LayerParams = { kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: 1, gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 }, fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' } as any
    let z = 0; forEachAnimatedRgba(audio, () => { z++ }); expect(z).toBe(0)
  })
})
