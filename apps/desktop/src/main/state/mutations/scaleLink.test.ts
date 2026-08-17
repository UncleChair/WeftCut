import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Animated, type Interpolation, type TextParams } from '../model'
import { createActor } from '../actor'
import { parseProject, serializeProject } from '../serialize'
import { scaleTracksTwins } from './scaleLink'

const lin: Interpolation = { kind: 'Linear' }
const kf = (entries: Array<[string, number, number, Interpolation?]>): Animated<number> =>
  ({ mode: 'Keyframed', value: entries.map(([id, t_us, value, interp]) => ({ id, t_us, value, interp: interp ?? lin })) })

describe('scaleTracksTwins', () => {
  it('Static: equal values are twins, unequal are not, mode mismatch is not', () => {
    expect(scaleTracksTwins({ mode: 'Static', value: 1 }, { mode: 'Static', value: 1 })).toBe(true)
    expect(scaleTracksTwins({ mode: 'Static', value: 1 }, { mode: 'Static', value: 2 })).toBe(false)
    expect(scaleTracksTwins({ mode: 'Static', value: 1 }, kf([['a', 0, 1]]))).toBe(false)
  })
  it('Keyframed: ids are IGNORED — same (t_us, value, interp) with different ids are twins', () => {
    expect(scaleTracksTwins(kf([['a', 0, 1], ['b', 1_000_000, 2]]), kf([['c', 0, 1], ['d', 1_000_000, 2]]))).toBe(true)
  })
  it('Keyframed: t_us, value, key count, and interp kind all discriminate', () => {
    const base = kf([['a', 0, 1], ['b', 1_000_000, 2]])
    expect(scaleTracksTwins(base, kf([['c', 0, 1], ['d', 999_999, 2]]))).toBe(false)
    expect(scaleTracksTwins(base, kf([['c', 0, 1], ['d', 1_000_000, 3]]))).toBe(false)
    expect(scaleTracksTwins(base, kf([['c', 0, 1]]))).toBe(false)
    expect(scaleTracksTwins(base, kf([['c', 0, 1], ['d', 1_000_000, 2, { kind: 'Hold' }]]))).toBe(false)
  })
  it('Bezier control points discriminate', () => {
    const bz = (p1: [number, number]): Interpolation => ({ kind: 'Bezier', p1, p2: [1, 1] })
    expect(scaleTracksTwins(kf([['a', 0, 1, bz([0.3, 0])]]), kf([['b', 0, 1, bz([0.3, 0])]]))).toBe(true)
    expect(scaleTracksTwins(kf([['a', 0, 1, bz([0.3, 0])]]), kf([['b', 0, 1, bz([0.4, 0])]]))).toBe(false)
  })
  it('malformed wire shapes compare as diverged, never throw', () => {
    expect(scaleTracksTwins(null as unknown as Animated<number>, { mode: 'Static', value: 1 })).toBe(false)
    expect(scaleTracksTwins({ mode: 'Keyframed', value: [null] } as unknown as Animated<number>, { mode: 'Keyframed', value: [null] } as unknown as Animated<number>)).toBe(false)
  })
})

function textActor() {
  const idGen = seededGen(); const initial = blankProject(idGen, 'sl')
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const id = (actor.dispatch('add_layer', { track: initial.tracks[1].id, kind: 'text', t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
  return { actor, id }
}
const textParams = (actor: ReturnType<typeof textActor>['actor']) =>
  actor.snapshot().tracks[1].layers[0].params as TextParams

describe('set_scale_linked', () => {
  it('new layers default to linked', () => {
    const { actor } = textActor()
    expect(textParams(actor).transform.scale_linked).toBe(true)
  })
  it('linking snaps scale_y to a fresh-id copy of scale_x — Keyframed X over Static Y, one undo restores both', () => {
    const { actor, id } = textActor()
    const track = kf([['00000000-0000-0000-0000-0000000000f1', 0, 1], ['00000000-0000-0000-0000-0000000000f2', 1_000_000, 2]])
    // Diverge first: keyframe X only (this also auto-unlinks, see invariant tests).
    expect(actor.dispatch('update_layer_param_track', { layer: id, param_key: 'scale_x', track }).ok).toBe(true)
    expect(textParams(actor).transform.scale_linked).toBe(false)
    const before = JSON.stringify(actor.snapshot())

    expect(actor.dispatch('set_scale_linked', { layer: id, linked: true }).ok).toBe(true)
    const t = textParams(actor).transform
    expect(t.scale_linked).toBe(true)
    expect(scaleTracksTwins(t.scale_x, t.scale_y)).toBe(true)
    expect(t.scale_y.mode).toBe('Keyframed')
    // Fresh ids on the copy: per-track identities never alias across the pair.
    const xIds = (t.scale_x as Extract<Animated<number>, { mode: 'Keyframed' }>).value.map((k) => k.id)
    const yIds = (t.scale_y as Extract<Animated<number>, { mode: 'Keyframed' }>).value.map((k) => k.id)
    expect(yIds.some((yid) => xIds.includes(yid))).toBe(false)

    expect(actor.dispatch('undo', {}).ok).toBe(true) // one commit → one undo restores Y AND the flag
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })
  it('unlinking touches only the flag — tracks stay twins', () => {
    const { actor, id } = textActor()
    expect(actor.dispatch('set_scale_linked', { layer: id, linked: false }).ok).toBe(true)
    const t = textParams(actor).transform
    expect(t.scale_linked).toBe(false)
    expect(scaleTracksTwins(t.scale_x, t.scale_y)).toBe(true)
  })
  it('rejects kinds without a transform', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sl')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const id = (actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    const r = actor.dispatch('set_scale_linked', { layer: id, linked: true })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('UnknownKeyframeParam')
  })
})

describe('scale-link invariant (result-based, same commit)', () => {
  it('a divergent single-axis track write clears the flag in the SAME commit (one undo restores value and flag)', () => {
    const { actor, id } = textActor()
    const before = JSON.stringify(actor.snapshot())
    const track = kf([['00000000-0000-0000-0000-0000000000f1', 0, 2]])
    expect(actor.dispatch('update_layer_param_track', { layer: id, param_key: 'scale_y', track }).ok).toBe(true)
    expect(textParams(actor).transform.scale_linked).toBe(false)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(JSON.stringify(actor.snapshot())).toBe(before) // flag clear rode the write's commit
  })
  it('a batch writing BOTH axes to twin tracks stays linked (mid-batch divergence is not a result)', () => {
    const { actor, id } = textActor()
    const before = JSON.stringify(actor.snapshot())
    const twin = () => kf([['00000000-0000-0000-0000-0000000000f1', 0, 1], ['00000000-0000-0000-0000-0000000000f2', 1_000_000, 2]])
    expect(actor.dispatch('update_layer_param_tracks', { layer: id, entries: [['scale_x', twin()], ['scale_y', twin()]] }).ok).toBe(true)
    const t = textParams(actor).transform
    expect(t.scale_linked).toBe(true)
    expect(t.scale_x.mode).toBe('Keyframed')
    // The twin fan-out is ONE commit: a single undo reverts both axes.
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })
  it('a divergent scalar params patch clears the flag; an equal both-axes patch does not', () => {
    // Text patches carry no scale fields, so this one runs on an ImageOverlay.
    const idGen = seededGen(); const initial = blankProject(idGen, 'sl2')
    const a2 = createActor({ initial, idGen, clock: () => '<TS>' })
    const IMG = '00000000-0000-0000-0000-0000000000aa'
    expect(a2.dispatch('add_media', { id: IMG, kind: 'Image', duration_us: null }).ok).toBe(true)
    const lid = (a2.dispatch('add_layer', { track: initial.tracks[1].id, kind: 'image', media: IMG, t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    const params = () => a2.snapshot().tracks[1].layers[0].params as { transform: { scale_linked: boolean } }
    expect(a2.dispatch('update_layer_params', { layer: lid, patch: { kind: 'ImageOverlay', scale_x: 2, scale_y: 2 } }).ok).toBe(true)
    expect(params().transform.scale_linked).toBe(true) // result is twins → still linked
    expect(a2.dispatch('update_layer_params', { layer: lid, patch: { kind: 'ImageOverlay', scale_y: 3 } }).ok).toBe(true)
    expect(params().transform.scale_linked).toBe(false) // result diverged → unlinked
  })
})

// The load-pass normalize for this flag: one default, one repair, no inference.
// It used to DERIVE an absent flag from a twin check; that inference went with the
// pre-v1 formats it existed for (ADR 0047) — v1 always writes the field, so
// absence now means hand-edited and gets the conservative answer.
describe('parseProject scale_linked normalize', () => {
  function wireWithoutFlag(diverge: boolean) {
    const { actor, id } = textActor()
    if (diverge) actor.dispatch('update_layer_param_track', { layer: id, param_key: 'scale_y', track: kf([['00000000-0000-0000-0000-0000000000f1', 0, 2]]) })
    // Deep copy: serializeProject is a shallow spread, so a `delete` on the raw
    // wire would reach back into the actor's live state.
    const wire = JSON.parse(JSON.stringify(serializeProject(actor.snapshot()))) as { tracks: Array<{ layers: Array<{ params: { transform: Record<string, unknown> } }> }> }
    delete wire.tracks[1].layers[0].params.transform.scale_linked
    return wire
  }
  it('absent flag → false, even when the tracks happen to be twins', () => {
    // Equal tracks are not evidence of intent, and linking is the destructive
    // direction (the next edit collapses one axis onto the other). So the default
    // never manufactures a link the file did not claim.
    const p = parseProject(wireWithoutFlag(false), { onGridRepair: () => {} })
    expect((p.tracks[1].layers[0].params as TextParams).transform.scale_linked).toBe(false)
  })
  it('absent flag + diverged tracks → false', () => {
    const p = parseProject(wireWithoutFlag(true), { onGridRepair: () => {} })
    expect((p.tracks[1].layers[0].params as TextParams).transform.scale_linked).toBe(false)
  })
  it('never leaves the flag undefined for the UI to read', () => {
    const p = parseProject(wireWithoutFlag(false), { onGridRepair: () => {} })
    expect('scale_linked' in (p.tracks[1].layers[0].params as TextParams).transform).toBe(true)
  })
  it('present flag is honored: explicit false over twin tracks stays false', () => {
    const wire = wireWithoutFlag(false)
    wire.tracks[1].layers[0].params.transform.scale_linked = false
    const p = parseProject(wire, { onGridRepair: () => {} })
    expect((p.tracks[1].layers[0].params as TextParams).transform.scale_linked).toBe(false)
  })
  it('a lying true over diverged tracks is repaired to false on load', () => {
    const wire = wireWithoutFlag(true)
    wire.tracks[1].layers[0].params.transform.scale_linked = true
    const p = parseProject(wire, { onGridRepair: () => {} })
    expect((p.tracks[1].layers[0].params as TextParams).transform.scale_linked).toBe(false)
  })
})
