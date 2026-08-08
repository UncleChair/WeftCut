import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  initEval,
  snapFrameRound,
  dbToLinear,
  roleAudible,
  loadTrack,
  evalTrack,
  MAX_KEYFRAMES,
} from './index'
import snap from '../snapFrameGolden.fixture.json'
import type { Interpolation } from '../../shared/easing'

beforeAll(async () => {
  await initEval()
})

describe('eval wasm smoke', () => {
  it('snap matches the snap golden', () => {
    const fx = snap as {
      cases: { fps_num: number; fps_den: number; samples: { t_us: number; expect: number }[] }[]
    }
    for (const c of fx.cases)
      for (const s of c.samples) expect(snapFrameRound(s.t_us, c.fps_num, c.fps_den)).toBe(s.expect)
  })

  it('dbToLinear ~ 2.0 at +6.0206 dB, 1.0 at 0 dB', () => {
    expect(dbToLinear(6.0206)).toBeCloseTo(2.0, 4)
    expect(dbToLinear(0)).toBeCloseTo(1.0, 6)
  })

  it('role gate: mute wins over solo', () => {
    expect(roleAudible(true, true, true)).toBe(false)
    expect(roleAudible(false, false, true)).toBe(false)
    expect(roleAudible(false, true, true)).toBe(true)
  })

  it('evalTrack linear midpoint + hold', () => {
    loadTrack(1, [
      { t_us: 0, value: 0, interp: { kind: 'Linear' } },
      { t_us: 1_000_000, value: 100, interp: { kind: 'Linear' } },
    ])
    expect(evalTrack(500_000, 0)).toBeCloseTo(50, 6)
    loadTrack(2, [
      { t_us: 0, value: 3, interp: { kind: 'Hold' } },
      { t_us: 1_000_000, value: 8, interp: { kind: 'Hold' } },
    ])
    expect(evalTrack(500_000, 0)).toBeCloseTo(3, 6)
  })

  it('Elastic and Bounce cross the ABI on their explicit codes', () => {
    // Pinned closed-form values (independent CPython derivation, spec formulas).
    loadTrack(3, [
      { t_us: 0, value: 0, interp: { kind: 'Elastic', dir: 'Out', amplitude: 1, period: 0.3 } },
      { t_us: 1_000_000, value: 10, interp: { kind: 'Linear' } },
    ])
    expect(evalTrack(250_000, 0)).toBeCloseTo(9.116116523516816, 9)
    loadTrack(4, [
      { t_us: 0, value: 0, interp: { kind: 'Bounce', dir: 'In' } },
      { t_us: 1_000_000, value: 10, interp: { kind: 'Linear' } },
    ])
    expect(evalTrack(500_000, 0)).toBeCloseTo(2.34375, 9)
  })

  it('an unknown interp kind falls back to Linear — deliberate, no bezier catch-all', () => {
    const assertSpy = vi.spyOn(console, 'assert').mockImplementation(() => {})
    loadTrack(5, [
      { t_us: 0, value: 0, interp: { kind: 'Wobble' } as unknown as Interpolation },
      { t_us: 1_000_000, value: 10, interp: { kind: 'Linear' } },
    ])
    expect(evalTrack(500_000, 0)).toBeCloseTo(5, 9)
    expect(assertSpy).toHaveBeenCalledWith(false, expect.stringContaining('unknown interp kind'), expect.anything())
    assertSpy.mockRestore()
  })

  it('truncates an over-capacity property to MAX_KEYFRAMES and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Linear 0..N-1 over 1ms steps; only the first MAX_KEYFRAMES are evaluated.
    const big = Array.from({ length: MAX_KEYFRAMES + 50 }, (_, i) => ({
      t_us: i * 1_000,
      value: i,
      interp: { kind: 'Linear' as const },
    }))
    loadTrack(100, big) // first oversized upload → warns
    loadTrack(101, big) // second → no further warning (once per session)
    expect(warn).toHaveBeenCalledTimes(1)
    // Still evaluates without throwing (truncated to the first MAX_KEYFRAMES keys);
    // at/after the last RESIDENT key it clamps to that key's value (= cap - 1).
    expect(evalTrack(MAX_KEYFRAMES * 1_000, 0)).toBe(MAX_KEYFRAMES - 1)
    warn.mockRestore()
  })
})
