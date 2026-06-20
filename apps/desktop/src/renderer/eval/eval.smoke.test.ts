import { describe, it, expect, beforeAll } from 'vitest'
import { initEval, snapFrameRound, dbToLinear, roleAudible, loadTrack, evalTrack } from './index'
import snap from '../snapFrameGolden.fixture.json'

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
})
