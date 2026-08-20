import { describe, it, expect } from 'vitest'
import { checkAllInvariants, invNoUnauthorizedOverlap, invGroupsWellFormed, invTransitionsWellFormed, InvariantError } from './invariants'
import type { WireProject, WireTransition } from './harness'

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
      transitions: [{ id: 'x', from_layer: 'l1', to_layer: 'l2', duration_us: 200, kind: { kind: 'Crossfade' }, extended_us: 0 }],
      composition: { ...base.composition, duration_us: 1800 } }
    expect(() => invNoUnauthorizedOverlap(ok)).not.toThrow()
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

describe('transition invariant (re-derived, Policy B reconcile guarantee)', () => {
  // Overlapped pair with an exactly-matching transition — the healthy shape.
  const withPair = (tr: Partial<WireTransition>, layers?: WireProject['tracks']): WireProject => ({ ...base,
    tracks: layers ?? [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
      { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
    ] }],
    transitions: [{ id: 'x', from_layer: 'l1', to_layer: 'l2', duration_us: 200, kind: { kind: 'Crossfade' }, extended_us: 0, ...tr }],
    composition: { ...base.composition, duration_us: 1800 } })

  it('accepts a healthy Crossfade, and a Wipe/Slide with direction', () => {
    expect(() => invTransitionsWellFormed(withPair({}))).not.toThrow()
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Wipe', direction: 'left' } }))).not.toThrow()
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Slide', direction: 'down' } }))).not.toThrow()
  })

  it('rejects duration !== geometric overlap', () =>
    expect(() => invTransitionsWellFormed(withPair({ duration_us: 300 }))).toThrow(InvariantError))

  it('rejects zero/negative duration', () => {
    // Layers adjacent (no overlap) so duration is the only violated law.
    const layers = [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
      { id: 'l2', t_start_us: 1000, t_end_us: 2000, params: { kind: 'Color' } },
    ] }]
    expect(() => invTransitionsWellFormed(withPair({ duration_us: 0 }, layers))).toThrow(InvariantError)
  })

  it('rejects a missing participant', () =>
    expect(() => invTransitionsWellFormed(withPair({ to_layer: 'ghost' }))).toThrow(InvariantError))

  it('rejects a self-referencing transition', () =>
    expect(() => invTransitionsWellFormed(withPair({ to_layer: 'l1' }))).toThrow(InvariantError))

  it('rejects a cross-track pair', () => {
    const layers = [
      { id: 'tA', layers: [{ id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } }] },
      { id: 'tB', layers: [{ id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } }] },
    ]
    expect(() => invTransitionsWellFormed(withPair({}, layers))).toThrow(InvariantError)
  })

  it('rejects an audio participant', () => {
    const layers = [{ id: 'tA', layers: [
      { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Audio' } },
      { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
    ] }]
    expect(() => invTransitionsWellFormed(withPair({}, layers))).toThrow(InvariantError)
  })

  it('rejects a layer participating twice on the same side', () => {
    const p: WireProject = { ...base,
      tracks: [{ id: 'tA', layers: [
        { id: 'l1', t_start_us: 0, t_end_us: 1000, params: { kind: 'Color' } },
        { id: 'l2', t_start_us: 800, t_end_us: 1800, params: { kind: 'Color' } },
        { id: 'l3', t_start_us: 1600, t_end_us: 2600, params: { kind: 'Color' } },
      ] }],
      transitions: [
        { id: 'x', from_layer: 'l1', to_layer: 'l2', duration_us: 200, kind: { kind: 'Crossfade' }, extended_us: 0 },
        { id: 'y', from_layer: 'l1', to_layer: 'l3', duration_us: 200, kind: { kind: 'Crossfade' }, extended_us: 0 },
      ],
      composition: { ...base.composition, duration_us: 2600 } }
    expect(() => invTransitionsWellFormed(p)).toThrow(InvariantError)
  })

  it('rejects malformed kind/direction pairings', () => {
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Crossfade', direction: 'left' } }))).toThrow(InvariantError)
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Wipe' } }))).toThrow(InvariantError)
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Slide', direction: 'diagonal' } }))).toThrow(InvariantError)
    expect(() => invTransitionsWellFormed(withPair({ kind: { kind: 'Dissolve' } }))).toThrow(InvariantError)
  })

  it('accepts extended_us at both lane edges (0 = pure placement, duration = full borrow)', () => {
    expect(() => invTransitionsWellFormed(withPair({ extended_us: 0 }))).not.toThrow()
    expect(() => invTransitionsWellFormed(withPair({ extended_us: 200 }))).not.toThrow()
  })

  it('rejects extended_us outside [0, duration_us]', () => {
    expect(() => invTransitionsWellFormed(withPair({ extended_us: -1 }))).toThrow(InvariantError)
    expect(() => invTransitionsWellFormed(withPair({ extended_us: 201 }))).toThrow(InvariantError)
  })
})
