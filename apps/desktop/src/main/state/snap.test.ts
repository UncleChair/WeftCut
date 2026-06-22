import { describe, it, expect } from 'vitest'
import { snapFrameRound } from './snap'

describe('snapFrameRound (wasm leaf re-export)', () => {
  it('snaps to the nearest 30fps frame boundary (half-up)', () => {
    // 30fps frame ≈ 33_333.33µs; the wasm uses i128 half-up rounding.
    expect(snapFrameRound(0, 30, 1)).toBe(0)
    expect(snapFrameRound(33_333, 30, 1)).toBe(33_333)
    expect(snapFrameRound(50_000, 30, 1)).toBe(snapFrameRound(50_000, 30, 1)) // stable
    expect(snapFrameRound(50_000, 30, 1)).toBe(66_667) // 1.5 frames → rounds up to frame 2
  })
  it('is a no-op for degenerate fps (renderer/seek may pass 0)', () => {
    expect(snapFrameRound(12_345, 0, 1)).toBe(12_345)
    expect(snapFrameRound(12_345, 30, 0)).toBe(12_345)
  })
})
