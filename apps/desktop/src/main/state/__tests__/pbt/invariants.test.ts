import { describe, it, expect } from 'vitest'
import { checkAllInvariants, invNoUnauthorizedOverlap, invDurationAutofit, invGroupsWellFormed, InvariantError } from './invariants'
import type { WireProject } from './harness'

const base: WireProject = {
  composition: { duration_us: 1000, duration_pinned: false, fps: { num: 30, den: 1 }, width: 1920, height: 1080 },
  tracks: [{ id: 'tA', layers: [{ id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } }] }],
  groups: [], transitions: [],
}

describe('structural invariants', () => {
  it('accepts a well-formed project', () => expect(() => checkAllInvariants(base)).not.toThrow())

  it('rejects unauthorized same-class overlap', () => {
    const bad: WireProject = { ...base, tracks: [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
      { id: 'l2', t_start_us: 500, t_end_us: 1500, params: { kind: 'Color' } },
    ] }], composition: { ...base.composition, duration_us: 1500 } }
    expect(() => invNoUnauthorizedOverlap(bad)).toThrow(InvariantError)
  })

  it('allows overlap exactly covered by an authorized transition', () => {
    const ok: WireProject = { ...base,
      tracks: [{ id: 'tA', layers: [
        { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
        { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
      ] }],
      transitions: [{ id: 'x', from_layer: 'l1', to_layer: 'l2', duration_us: 200 }],
      composition: { ...base.composition, duration_us: 1800 } }
    expect(() => invNoUnauthorizedOverlap(ok)).not.toThrow()
  })

  it('accepts duration shorter than max-end when unpinned (update_layer skips autofit)', () => {
    // update_layer intentionally does not call applyDurationAutofit in both Rust
    // and TS actors, so duration_us can legitimately fall behind max layer end on
    // unpinned projects. Confirmed by oracle states: update-layer-times.json and
    // update-layer-undo.json. The invariant cannot assert strict equality here.
    const ok: WireProject = { ...base, composition: { ...base.composition, duration_us: 999, duration_pinned: false } }
    expect(() => invDurationAutofit(ok)).not.toThrow()
  })

  it('ignores duration when pinned (overflow guard is write-time, not a read invariant)', () => {
    const ok: WireProject = { ...base, composition: { ...base.composition, duration_us: 999, duration_pinned: true } }
    expect(() => invDurationAutofit(ok)).not.toThrow()
  })

  it('rejects a layer in two groups', () => {
    const bad: WireProject = { ...base,
      tracks: [{ id: 'tA', layers: [
        { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
        { id: 'l2', t_start_us: 1000, t_end_us: 2000, params: { kind: 'Color' } },
      ] }],
      groups: [{ id: 'g1', members: ['l1', 'l2'] }, { id: 'g2', members: ['l2'] }],
      composition: { ...base.composition, duration_us: 2000 } }
    expect(() => invGroupsWellFormed(bad)).toThrow(InvariantError)
  })
})
