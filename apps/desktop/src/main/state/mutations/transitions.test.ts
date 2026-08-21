import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project, type Transition } from '../model'
import { createActor, type ActorLogEntry } from '../actor'
import { applyAddLayer, applyAddTrack, colorParams, defaultTransform, textParamsDefault } from './add'
import { extendLayerTEnd, shrinkLayerTEnd, applyAddTransition, applyRemoveTransition, applyUpdateTransition } from './transitions'
import { frameIndexRound, timeUsAtFrame } from '../snap'
import { isCommandFailure } from '../errors'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const CROSSFADE = { kind: 'Crossfade' as const }
const color = () => colorParams(RED, 1920, 1080)
/** applyAddTransition, id only — for the call sites that don't assert bounces. */
function addT(p: Project, gen: IdGen, from: string, to: string, durUs: number, placement: 'overlap' | 'extend' = 'overlap'): string {
  return applyAddTransition(p, gen, from, to, durUs, CROSSFADE, placement).id
}

/** Two adjacent color layers on @A: A1=[0,2M], A2=[2M,4M]. Returns gen for id-order asserts. */
function twoAdjacent(): { p: Project; gen: IdGen; a1: string; a2: string } {
  const gen = seededGen()
  const p = blankProject(gen, 't') // #1 A #2 B #3 project
  const a1 = applyAddLayer(p, gen, p.tracks[0].id, color(), 0, 2_000_000) // #4
  const a2 = applyAddLayer(p, gen, p.tracks[0].id, color(), 2_000_000, 4_000_000) // #5
  return { p, gen, a1, a2 }
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}
/** Like expectCmd but returns the full err payload for deep-equality asserts. */
function expectCmdErr(fn: () => void): Record<string, unknown> {
  try { fn() } catch (e) { if (isCommandFailure(e)) return e.err as unknown as Record<string, unknown>; throw e }
  throw new Error('expected a CommandFailure')
}
function layerOf(p: Project, id: string): Layer {
  for (const t of p.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error('layer not found')
}
function srcOutOf(p: Project, id: string): number { return (layerOf(p, id).params as { src_out_us: number }).src_out_us }

/** Minimal MediaItem so the tail-handle pre-check sees a real pool entry. */
function addMedia(p: Project, id: string, kind: 'Video' | 'Audio', durationUs: number | null): void {
  p.media_pool[id] = { id, label: null, path_abs: '/x', path_rel: null, kind, metadata: { duration_us: durationUs },
    file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' },
    conform_path: null, waveform_path: null, thumbnails_dir: null }
}
function videoParams(media: string, srcIn: number, srcOut: number): LayerParams {
  return { kind: 'VideoClip', media, src_in_us: srcIn, src_out_us: srcOut, transform: defaultTransform(),
    opacity: { mode: 'Static', value: 1 }, crop: null, flip_h: false, flip_v: false,
    blend_mode: 'Normal', speed: 1, fade_in_us: 0, fade_out_us: 0 }
}
function audioParams(media: string, srcIn: number, srcOut: number): LayerParams {
  return { kind: 'Audio', media, src_in_us: srcIn, src_out_us: srcOut,
    gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
    fade_in_us: 0, fade_out_us: 0, mute: false, role: 'dialogue' }
}
/** VideoClip A1=[0,2M] (media 'm' src 0..2M, media duration mediaDurUs) then Color A2=[2M,4M]. */
function videoThenColor(mediaDurUs: number | null): { p: Project; gen: IdGen; a1: string; a2: string } {
  const gen = seededGen()
  const p = blankProject(gen, 't') // #1 A #2 B #3 project
  addMedia(p, 'm', 'Video', mediaDurUs)
  const a1 = applyAddLayer(p, gen, p.tracks[0].id, videoParams('m', 0, 2_000_000), 0, 2_000_000) // #4
  const a2 = applyAddLayer(p, gen, p.tracks[0].id, color(), 2_000_000, 4_000_000) // #5
  return { p, gen, a1, a2 }
}

describe('extendLayerTEnd / shrinkLayerTEnd', () => {
  it('extend color layer touches only t_end_us', () => {
    const { p, a1 } = twoAdjacent()
    const l: Layer = layerOf(p, a1)
    const before = l.t_end_us
    extendLayerTEnd(l, 1_000_000)
    expect(l.t_end_us).toBe(before + 1_000_000)
    expect(l.params.kind).toBe('Color') // no src_out_us on color
  })
  it('extend then shrink an Audio layer touches t_end_us AND src_out_us (saturating at 0)', () => {
    const l: Layer = {
      id: 'y', label: null, t_start_us: 0, t_end_us: 2_000_000, enabled: true, locked: false,
      metadata: {}, effects: [],
      params: { kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: 2_000_000,
        gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
        fade_in_us: 0, fade_out_us: 0, mute: false, role: 'dialogue' },
    }
    extendLayerTEnd(l, 500_000)
    expect([l.t_end_us, (l.params as { src_out_us: number }).src_out_us]).toEqual([2_500_000, 2_500_000])
    shrinkLayerTEnd(l, 5_000_000) // over-shrink saturates at 0
    expect([l.t_end_us, (l.params as { src_out_us: number }).src_out_us]).toEqual([0, 0])
  })
  it('extend then shrink a VideoClip touches t_end_us AND src_out_us (saturating at 0)', () => {
    const l: Layer = {
      id: 'x', label: null, t_start_us: 0, t_end_us: 2_000_000, enabled: true, locked: false,
      metadata: {}, effects: [],
      params: { kind: 'VideoClip', media: 'm', src_in_us: 0, src_out_us: 2_000_000,
        transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 },
          scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 },
          rotation_deg: { mode: 'Static', value: 0 }, anchor_x: { mode: 'Static', value: 0.5 }, anchor_y: { mode: 'Static', value: 0.5 }, scale_linked: true },
        opacity: { mode: 'Static', value: 1 }, crop: null, flip_h: false, flip_v: false,
        blend_mode: 'Normal', speed: 1, fade_in_us: 0, fade_out_us: 0 },
    }
    extendLayerTEnd(l, 500_000)
    expect([l.t_end_us, (l.params as { src_out_us: number }).src_out_us]).toEqual([2_500_000, 2_500_000])
    shrinkLayerTEnd(l, 5_000_000) // over-shrink saturates at 0
    expect([l.t_end_us, (l.params as { src_out_us: number }).src_out_us]).toEqual([0, 0])
  })
})

describe('applyAddTransition', () => {
  it('default overlap placement: the incoming layer moves LEFT by the duration; the outgoing layer is untouched (id #6)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const { id: tid, bounces } = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE) // #6
    expect(tid).toBe('00000000-0000-0000-0000-000000000006')
    expect(bounces).toEqual([]) // no siblings → nothing to bounce
    expect([layerOf(p, a1).t_start_us, layerOf(p, a1).t_end_us]).toEqual([0, 2_000_000]) // A untouched
    expect([layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]).toEqual([1_000_000, 3_000_000]) // B left by d
    // extended_us = 0: the overlap came from placement, no tail was borrowed.
    expect(p.transitions).toEqual([{ id: tid, from_layer: a1, to_layer: a2, duration_us: 1_000_000, kind: CROSSFADE, extended_us: 0 }])
    // Window adjacency: [B.start, A.end] and overlap === duration (validate's rule).
    expect(layerOf(p, a1).t_end_us - layerOf(p, a2).t_start_us).toBe(1_000_000)
  })
  it("explicit placement 'extend': the tail borrow — from_layer extends, positions untouched, full-borrow provenance", () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend') // #6
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // extended by 1M
    expect(layerOf(p, a2).t_start_us).toBe(2_000_000) // B never moves on extend
    // extended_us = duration: the whole overlap is borrowed tail.
    expect(p.transitions).toEqual([{ id: tid, from_layer: a1, to_layer: a2, duration_us: 1_000_000, kind: CROSSFADE, extended_us: 1_000_000 }])
  })
  it('already overlapping by exactly duration classifies as overlap under BOTH placements: nothing moves, extended_us 0', () => {
    for (const placement of ['overlap', 'extend'] as const) {
      const { p, gen, a1, a2 } = twoAdjacent()
      layerOf(p, a1).t_end_us = 3_000_000 // hand-position a pre-overlap of 1M (unreachable via the API)
      const tid = addT(p, gen, a1, a2, 1_000_000, placement)
      expect(layerOf(p, a1).t_end_us, placement).toBe(3_000_000) // unchanged
      expect(layerOf(p, a2).t_start_us, placement).toBe(2_000_000) // unchanged
      expect(p.transitions.map((t) => t.id)).toEqual([tid])
      expect(p.transitions[0].extended_us).toBe(0) // nothing borrowed
    }
  })
  it('gap or wrong overlap → TransitionLayersNotAdjacent (no id minted)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a2).t_start_us = 3_000_000; layerOf(p, a2).t_end_us = 5_000_000 // gap [2M..3M]
    expectCmd(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE), 'TransitionLayersNotAdjacent')
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6, not #7 → no burn
  })
  it('missing from/to layer → LayerNotFound (no id minted)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    expectCmd(() => applyAddTransition(p, gen, 'ghost', a2, 1_000_000, CROSSFADE), 'LayerNotFound')
    expectCmd(() => applyAddTransition(p, gen, a1, 'ghost', 1_000_000, CROSSFADE), 'LayerNotFound')
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6 → no burn
  })
})

describe('applyAddTransition overlap-placement refusals (all pre-id-mint, never a silent extend fallback)', () => {
  it('d > min(len_A, len_B) → ValidationFailed(TransitionDurationOutOfRange, transition: null); nothing moves, NO id burned', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a2).t_end_us = 2_500_000 // len_B = 500k < d = 1M
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)))
      .toEqual({ error: 'ValidationFailed', detail: { rule: 'TransitionDurationOutOfRange', transition: null, duration: 1_000_000 } })
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([2_000_000, 2_000_000]) // untouched
    expect(p.transitions).toEqual([])
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6 → no burn
  })
  it('d > len_A refuses too (the bound is min over BOTH spans, so B can never cross t = 0 by its own move)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a1).t_start_us = 1_500_000 // len_A = 500k < d = 1M
    expectCmd(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE), 'ValidationFailed')
    expect(layerOf(p, a2).t_start_us).toBe(2_000_000)
  })
  it('d === min(len_A, len_B) is the boundary and succeeds (B lands flush on A.start)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    addT(p, gen, a1, a2, 2_000_000) // d = len_A = len_B = 2M
    expect([layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]).toEqual([0, 2_000_000])
    expect(p.transitions[0].duration_us).toBe(2_000_000)
  })
  it('participants sharing a group → TransitionParticipantsShareGroup {from, to}; NO id burned', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    p.groups.push({ id: 'g', members: [a1, a2].sort() })
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)))
      .toEqual({ error: 'TransitionParticipantsShareGroup', from: a1, to: a2 })
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([2_000_000, 2_000_000])
    expect(p.transitions).toEqual([])
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6 → no burn
  })
  it("shared group does NOT block placement 'extend' (nothing moves there) or a pre-overlapped classify", () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    p.groups.push({ id: 'g', members: [a1, a2].sort() })
    expect(() => addT(p, gen, a1, a2, 1_000_000, 'extend')).not.toThrow()
  })
  it('a group sibling pushed across t = 0 → ValidationFailed(NegativeLayerStart) naming the SIBLING; nothing moves, NO id burned', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    addMedia(p, 'm', 'Audio', 10_000_000)
    // Sibling starts 300k from the origin; the 1M leftward shift would land it at −700k.
    const aud = applyAddLayer(p, gen, p.tracks[1].id, audioParams('m', 0, 1_000_000), 300_000, 1_300_000) // #6
    p.groups.push({ id: 'g', members: [a2, aud].sort() })
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)))
      .toEqual({ error: 'ValidationFailed', detail: { rule: 'NegativeLayerStart', layer: aud, t_start: -700_000 } })
    expect([layerOf(p, a2).t_start_us, layerOf(p, aud).t_start_us]).toEqual([2_000_000, 300_000]) // untouched
    expect(p.transitions).toEqual([])
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 5_000_000, 6_000_000)).toBe('00000000-0000-0000-0000-000000000007') // #7 → no burn
  })
})

describe('applyAddTransition overlap placement: geometry consequences', () => {
  it('no ripple: the vacated span stays a gap — no other layer moves', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const c = applyAddLayer(p, gen, p.tracks[0].id, color(), 4_000_000, 6_000_000) // downstream, ungrouped
    const d = applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 3_000_000) // other lane
    addT(p, gen, a1, a2, 1_000_000)
    expect([layerOf(p, c).t_start_us, layerOf(p, c).t_end_us]).toEqual([4_000_000, 6_000_000]) // unmoved
    expect([layerOf(p, d).t_start_us, layerOf(p, d).t_end_us]).toEqual([0, 3_000_000]) // unmoved
    expect(layerOf(p, a2).t_end_us).toBe(3_000_000) // gap [3M, 4M) left behind — D3
  })
  it('autofit follows the overlap add (max t_end shrinks) and the remove restores it', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    expect(p.composition.duration_us).toBe(4_000_000) // from the seed adds
    const tid = addT(p, gen, a1, a2, 1_000_000)
    expect(p.composition.duration_us).toBe(3_000_000) // B's end moved left
    applyRemoveTransition(p, tid)
    expect(p.composition.duration_us).toBe(4_000_000)
  })
  it('add → remove round-trip on an overlap add restores the original geometry exactly', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const before = JSON.stringify(p.tracks)
    const tid = addT(p, gen, a1, a2, 1_000_000)
    applyRemoveTransition(p, tid)
    expect(JSON.stringify(p.tracks)).toBe(before)
    expect(layerOf(p, a2).t_start_us).toBe(layerOf(p, a1).t_end_us) // adjacency restored exactly
  })
})

describe("applyAddTransition tail-handle pre-check (placement 'extend' only)", () => {
  it('insufficient handle → TransitionInsufficientHandle with available_us; geometry untouched; NO id burned', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_500_000) // handle = 2.5M − src_out 2M = 500k
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE, 'extend')))
      .toEqual({ error: 'TransitionInsufficientHandle', layer: a1, available_us: 500_000 })
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_000_000, 2_000_000]) // untouched
    expect(p.transitions).toEqual([])
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6, not #7 → no burn
  })
  it('overlap placement never handle-checks: the same zero-handle geometry succeeds by moving B (no source material touched)', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_000_000) // handle = 0
    addT(p, gen, a1, a2, 1_000_000) // default overlap
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_000_000, 2_000_000]) // A untouched
    expect(layerOf(p, a2).t_start_us).toBe(1_000_000)
    expect(p.transitions[0].extended_us).toBe(0)
  })
  it('exact-fit handle (available === duration) succeeds', () => {
    const { p, gen, a1, a2 } = videoThenColor(3_000_000) // handle = 1M
    addT(p, gen, a1, a2, 1_000_000, 'extend')
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([3_000_000, 3_000_000])
  })
  it('null media duration = unknowable → unlimited (mirrors SrcRangeExceedsMedia firing only on non-null)', () => {
    const { p, gen, a1, a2 } = videoThenColor(null)
    expect(() => addT(p, gen, a1, a2, 1_000_000, 'extend')).not.toThrow()
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
  })
  it('free-duration outgoing (Text) has unlimited handle', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const a1 = applyAddLayer(p, gen, p.tracks[0].id, textParamsDefault('hi'), 0, 2_000_000)
    const a2 = applyAddLayer(p, gen, p.tracks[0].id, color(), 2_000_000, 4_000_000)
    addT(p, gen, a1, a2, 1_000_000, 'extend')
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
  })
  it('pre-positioned overlap extends nothing → no handle pre-check even at zero handle', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_000_000) // handle = 0
    layerOf(p, a1).t_end_us = 3_000_000 // hand-position a pre-overlap of 1M (unreachable via the API)
    expect(() => addT(p, gen, a1, a2, 1_000_000, 'extend')).not.toThrow()
  })
})

describe('applyAddTransition audio rejection', () => {
  it('Audio from-layer → TransitionUnsupportedLayerKind naming it; NO id burned', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't') // #1 A #2 B #3 project
    addMedia(p, 'm', 'Audio', 10_000_000)
    const a1 = applyAddLayer(p, gen, p.tracks[0].id, audioParams('m', 0, 2_000_000), 0, 2_000_000) // #4
    const a2 = applyAddLayer(p, gen, p.tracks[0].id, audioParams('m', 2_000_000, 4_000_000), 2_000_000, 4_000_000) // #5
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)))
      .toEqual({ error: 'TransitionUnsupportedLayerKind', layer: a1, kind: 'Audio' })
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6 → no burn
  })
  it('Audio to-layer → TransitionUnsupportedLayerKind names the to layer', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    addMedia(p, 'm', 'Audio', 10_000_000)
    const a1 = applyAddLayer(p, gen, p.tracks[0].id, color(), 0, 2_000_000)
    const a2 = applyAddLayer(p, gen, p.tracks[0].id, audioParams('m', 0, 2_000_000), 2_000_000, 4_000_000)
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)))
      .toEqual({ error: 'TransitionUnsupportedLayerKind', layer: a2, kind: 'Audio' })
    expect(p.transitions).toEqual([])
  })
})

// Update-routing tests build their fixture with placement 'extend' where the
// scenario needs a live borrow (e = d after add); overlap-add fixtures (e = 0)
// say so. The routing itself is placement-blind — it reads only (d, e).
describe('applyUpdateTransition', () => {
  it('grows duration without an explicit extended_us: the incoming layer moves left, the tail never borrows', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend') // a1 → 3M, e = 1M
    applyUpdateTransition(p, tid, { duration_us: 1_500_000 })
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // sacred-preferring: no new borrow
    expect([layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]).toEqual([1_500_000, 3_500_000])
    expect(p.transitions[0]).toMatchObject({ duration_us: 1_500_000, extended_us: 1_000_000 })
  })
  it('shrinks duration: returns borrowed tail first; the incoming layer stays while e covers the shrink', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    applyUpdateTransition(p, tid, { duration_us: 400_000 })
    expect(layerOf(p, a1).t_end_us).toBe(2_400_000)
    expect(layerOf(p, a2).t_start_us).toBe(2_000_000) // shrink came entirely out of the borrow
    expect(p.transitions[0]).toMatchObject({ duration_us: 400_000, extended_us: 400_000 })
  })
  it('shrinks past the borrow: the remainder moves the incoming layer right (mixed provenance)', () => {
    // Pre-overlap of 600k + borrow of 400k: shrink to 500k returns all 400k of
    // borrow first (e′ = 0), then moves B right by the remaining 100k... built
    // via explicit extended_us since no v1 add produces a partial borrow.
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend') // e = 1M, S = 2M
    applyUpdateTransition(p, tid, { duration_us: 1_000_000, extended_us: 400_000 }) // A.end → 2.4M, B.start → 1.4M
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([2_400_000, 1_400_000])
    applyUpdateTransition(p, tid, { duration_us: 500_000 })
    // Δd = 500k; borrow covers 400k (A.end back to S = 2M), B moves right 100k.
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([2_000_000, 1_500_000])
    expect(p.transitions[0]).toMatchObject({ duration_us: 500_000, extended_us: 0 })
  })
  it('e = 0 boundary: shrinking a pure-placement transition moves ONLY the incoming layer', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a1).t_end_us = 3_000_000 // hand-positioned pre-overlap → e = 0, S = 3M
    const tid = addT(p, gen, a1, a2, 1_000_000)
    applyUpdateTransition(p, tid, { duration_us: 500_000 })
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // never trimmed — the end is real content
    expect(layerOf(p, a2).t_start_us).toBe(2_500_000)
    expect(p.transitions[0]).toMatchObject({ duration_us: 500_000, extended_us: 0 })
  })
  it('explicit extended_us with unchanged duration slides the whole window along the outgoing tail', () => {
    const { p, gen, a1, a2 } = videoThenColor(4_000_000) // handle 2M
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend') // A.end 3M, e = 1M, S = 2M
    applyUpdateTransition(p, tid, { extended_us: 500_000 })
    // e′ = 500k: A.end returns to 2.5M and B follows to keep d = 1M.
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_500_000, 2_500_000])
    expect(layerOf(p, a2).t_start_us).toBe(1_500_000)
    expect(p.transitions[0]).toMatchObject({ duration_us: 1_000_000, extended_us: 500_000 })
  })
  it('explicit extended_us above duration → InvalidArgument; a small negative rounds to frame 0 and returns the whole borrow', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    const err = expectCmdErr(() => applyUpdateTransition(p, tid, { extended_us: 1_500_000 }))
    expect([err.error, err.field]).toEqual(['InvalidArgument', 'extended_us'])
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([3_000_000, 2_000_000])
    // −1 µs is a LEGAL explicit target (spec D6): it rounds to frame 0, so
    // e′ = 0 — A.end returns to S and B follows left to keep d. The negative
    // request never lands negative in the store.
    applyUpdateTransition(p, tid, { extended_us: -1 })
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([2_000_000, 1_000_000])
    expect(p.transitions[0]).toMatchObject({ duration_us: 1_000_000, extended_us: 0 })
  })
  it('kind-only patch is a pure field swap — geometry untouched', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    applyUpdateTransition(p, tid, { kind: { kind: 'Wipe', direction: 'left' } })
    expect(p.transitions[0].kind).toEqual({ kind: 'Wipe', direction: 'left' })
    expect([layerOf(p, a1).t_end_us, p.transitions[0].duration_us]).toEqual([3_000_000, 1_000_000])
  })
  it('one patch may change duration AND kind together', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    applyUpdateTransition(p, tid, { duration_us: 500_000, kind: { kind: 'Slide', direction: 'up' } })
    expect(layerOf(p, a1).t_end_us).toBe(2_500_000)
    expect(p.transitions[0]).toEqual({ id: tid, from_layer: a1, to_layer: a2, duration_us: 500_000, kind: { kind: 'Slide', direction: 'up' }, extended_us: 500_000 })
  })
  it('TransitionInsufficientHandle fires ONLY on e′ > e: implicit growth at zero handle succeeds, explicit borrow fails', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_500_000) // handle 500k
    const tid = addT(p, gen, a1, a2, 500_000, 'extend') // consumes it all: src_out → 2.5M, e = 500k
    // Implicit growth keeps e′ = e — no source material is touched, so the
    // exhausted handle is irrelevant: B opens the overlap by moving left.
    applyUpdateTransition(p, tid, { duration_us: 1_000_000 })
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_500_000, 2_500_000])
    expect(layerOf(p, a2).t_start_us).toBe(1_500_000)
    // Explicit borrow growth (e′ > e) is the one handle-consuming path.
    expect(expectCmdErr(() => applyUpdateTransition(p, tid, { extended_us: 1_000_000 })))
      .toEqual({ error: 'TransitionInsufficientHandle', layer: a1, available_us: 0 })
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1), layerOf(p, a2).t_start_us]).toEqual([2_500_000, 2_500_000, 1_500_000])
    expect(p.transitions[0]).toMatchObject({ duration_us: 1_000_000, extended_us: 500_000 })
  })
  it('explicit borrow growth within the handle extends the tail AND src_out_us; the incoming layer holds still', () => {
    const { p, gen, a1, a2 } = videoThenColor(4_000_000) // handle 2M
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend') // src_out → 3M, e = 1M
    applyUpdateTransition(p, tid, { duration_us: 1_500_000, extended_us: 1_500_000 }) // borrow delta 500k ≤ 4M − 3M
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([3_500_000, 3_500_000])
    expect(layerOf(p, a2).t_start_us).toBe(2_000_000) // full-borrow growth: B never moves
    expect(p.transitions[0]).toMatchObject({ duration_us: 1_500_000, extended_us: 1_500_000 })
  })
  it('duration must stay > 0 → ValidationFailed(TransitionDurationOutOfRange); geometry untouched', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    expect(expectCmdErr(() => applyUpdateTransition(p, tid, { duration_us: 0 })))
      .toEqual({ error: 'ValidationFailed', detail: { rule: 'TransitionDurationOutOfRange', transition: tid, duration: 0 } })
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
  })
  it('empty and same-duration patches are no-ops', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    applyUpdateTransition(p, tid, {})
    applyUpdateTransition(p, tid, { duration_us: 1_000_000 })
    expect([layerOf(p, a1).t_end_us, p.transitions[0].duration_us]).toEqual([3_000_000, 1_000_000])
  })
  it('unknown id → TransitionNotFound', () => {
    const { p } = twoAdjacent()
    expectCmd(() => applyUpdateTransition(p, 'ghost', { duration_us: 500_000 }), 'TransitionNotFound')
  })
})

// The chip's right edge dragged left past S sends (d′ = R − B.start,
// e′ = R − S < 0) in one patch — the genuine tail trim of spec D6.
describe('applyUpdateTransition explicit negative extended_us (right-edge tail trim)', () => {
  it('trims A to exactly R with src_out in sync; B.start untouched; stored e′ = 0; d′ = R − B.start', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_500_000)
    const tid = addT(p, gen, a1, a2, 1_000_000) // overlap: B [1M,3M], S = A.end = 2M, e = 0
    applyUpdateTransition(p, tid, { duration_us: 500_000, extended_us: -500_000 }) // R = 1.5M < S
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([1_500_000, 1_500_000])
    expect(layerOf(p, a2).t_start_us).toBe(1_000_000)
    expect(p.transitions[0]).toMatchObject({ duration_us: 500_000, extended_us: 0 })
  })
  it('a negative e′ whose paired d′ rounds under 1 frame refuses (InvalidArgument on duration_us), state untouched', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_500_000)
    const tid = addT(p, gen, a1, a2, 1_000_000)
    const err = expectCmdErr(() => applyUpdateTransition(p, tid, { duration_us: 10_000, extended_us: -990_000 }))
    expect([err.error, err.field]).toEqual(['InvalidArgument', 'duration_us'])
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1), layerOf(p, a2).t_start_us]).toEqual([2_000_000, 2_000_000, 1_000_000])
    expect(p.transitions[0]).toMatchObject({ duration_us: 1_000_000, extended_us: 0 })
  })
  it('round-trip: right-edge borrow → trim past S → remove restores adjacency at the NEW sacred end', () => {
    const { p, gen, a1, a2 } = videoThenColor(4_000_000)
    const tid = addT(p, gen, a1, a2, 1_000_000) // B [1M,3M], S = 2M
    applyUpdateTransition(p, tid, { duration_us: 1_500_000, extended_us: 500_000 }) // borrow: A.end → 2.5M
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_500_000, 2_500_000])
    applyUpdateTransition(p, tid, { duration_us: 800_000, extended_us: -200_000 }) // trim past S: R = 1.8M
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([1_800_000, 1_800_000])
    expect(p.transitions[0]).toMatchObject({ duration_us: 800_000, extended_us: 0 })
    // The trim moved the sacred end itself, so remove does NOT undo it: e = 0
    // routes the whole restore through B, landing flush on the NEW end.
    applyRemoveTransition(p, tid)
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([1_800_000, 1_800_000])
    expect(layerOf(p, a2).t_start_us).toBe(1_800_000)
    expect(layerOf(p, a2).t_start_us).toBe(layerOf(p, a1).t_end_us) // adjacency exact
  })
})

// ── the composition frame grid ───────────────────────────────────────────────
// The spec's full rate matrix. The 1001-denominator rates are where the bug
// bites: `canonical(k) + canonical(n) != canonical(k + n)`, so a duration has to
// be measured FROM the cut or the endpoint leaves the grid.
const RATES: Array<[number, number]> = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1],
]

/** Two adjacent color layers at `num/den`, cut on frame `cutFrame`, each
 *  `spanFrames` long — so every endpoint starts canonical. */
function adjacentAt(num: number, den: number, cutFrame: number, spanFrames: number): { p: Project; gen: IdGen; a1: string; a2: string; cutUs: number } {
  const gen = seededGen()
  const p = blankProject(gen, 't') // #1 A #2 B #3 project
  p.composition.fps = { num, den }
  const at = (f: number) => timeUsAtFrame(f, num, den)
  const cutUs = at(cutFrame)
  const a1 = applyAddLayer(p, gen, p.tracks[0].id, color(), at(cutFrame - spanFrames), cutUs) // #4
  const a2 = applyAddLayer(p, gen, p.tracks[0].id, color(), cutUs, at(cutFrame + spanFrames)) // #5
  return { p, gen, a1, a2, cutUs }
}
const isCanonical = (us: number, num: number, den: number) => timeUsAtFrame(frameIndexRound(us, num, den), num, den) === us
/** validate.ts's `overlap` for a transition, re-derived here so the rule is
 *  asserted without importing the validator. */
function overlapUs(p: Project, tr: Transition): number {
  const from = layerOf(p, tr.from_layer)
  const to = layerOf(p, tr.to_layer)
  return Math.max(Math.min(from.t_end_us, to.t_end_us) - Math.max(from.t_start_us, to.t_start_us), 0)
}
/** The update-side grid contract: the window [B.start, A.end] spans exactly
 *  `frameIndexRound(requested)` frames, both participants' endpoints are
 *  canonical, and overlap === duration_us. Anchor-free (unlike expectOnGrid)
 *  because update moves BOTH edges relative to the sacred end, so the original
 *  cut frame is not where the window lives any more. */
function expectWindowOnGrid(p: Project, tid: string, num: number, den: number, requestedUs: number): void {
  const tr = p.transitions.find((t) => t.id === tid)!
  const frames = frameIndexRound(requestedUs, num, den)
  const from = layerOf(p, tr.from_layer)
  const to = layerOf(p, tr.to_layer)
  for (const t of [from.t_start_us, from.t_end_us, to.t_start_us, to.t_end_us]) expect(isCanonical(t, num, den)).toBe(true)
  expect(frameIndexRound(from.t_end_us, num, den) - frameIndexRound(to.t_start_us, num, den)).toBe(frames)
  expect(tr.duration_us).toBe(from.t_end_us - to.t_start_us)
  expect(overlapUs(p, tr)).toBe(tr.duration_us)
}

/** Duration spans whole frames from the cut, both endpoints stay canonical,
 *  overlap === duration_us — asserted together. */
function expectOnGrid(p: Project, tid: string, num: number, den: number, cutFrame: number, requestedUs: number): void {
  const tr = p.transitions.find((t) => t.id === tid)!
  const frames = frameIndexRound(requestedUs, num, den)
  expect(frames).toBeGreaterThanOrEqual(1)
  // duration spans exactly `frames` grid intervals measured from the cut
  expect(tr.duration_us).toBe(timeUsAtFrame(cutFrame + frames, num, den) - timeUsAtFrame(cutFrame, num, den))
  // both participants' endpoints stayed on the grid
  for (const id of [tr.from_layer, tr.to_layer]) {
    expect(isCanonical(layerOf(p, id).t_start_us, num, den)).toBe(true)
    expect(isCanonical(layerOf(p, id).t_end_us, num, den)).toBe(true)
  }
  // validate.ts's overlap === duration_us rule
  expect(overlapUs(p, tr)).toBe(tr.duration_us)
}

describe('transition durations enter the composition frame grid', () => {
  it.each(RATES)("%i/%i: an off-grid extend-add duration snaps to whole frames FORWARD from the cut at every cut phase", (num, den) => {
    // Several cut phases: at 1001-denominator rates the ±1 µs error in
    // `canonical(k) + canonical(n)` depends on k, so one phase proves nothing.
    for (const cutFrame of [60, 61, 67, 601]) {
      const { p, gen, a1, a2 } = adjacentAt(num, den, cutFrame, 60)
      const tid = addT(p, gen, a1, a2, 500_000, 'extend')
      expectOnGrid(p, tid, num, den, cutFrame, 500_000)
      expect(layerOf(p, a1).t_end_us).toBe(timeUsAtFrame(cutFrame + frameIndexRound(500_000, num, den), num, den))
    }
  })

  it.each(RATES)('%i/%i: an overlap add measures the duration BACKWARD from the cut; B lands on the canonical boundary, A untouched', (num, den) => {
    // The mirror of the forward test above: B.start′ must be the canonical
    // boundary `frames` BELOW the cut, so the window [B.start′, A.end] spans
    // whole frames between canonical endpoints at every cut phase.
    for (const cutFrame of [60, 61, 67, 601]) {
      const { p, gen, a1, a2, cutUs } = adjacentAt(num, den, cutFrame, 60)
      const frames = frameIndexRound(500_000, num, den)
      const tid = addT(p, gen, a1, a2, 500_000)
      const tr = p.transitions.find((t) => t.id === tid)!
      expect(layerOf(p, a1).t_end_us).toBe(cutUs) // A untouched
      expect(layerOf(p, a2).t_start_us).toBe(timeUsAtFrame(cutFrame - frames, num, den))
      expect(tr.duration_us).toBe(cutUs - timeUsAtFrame(cutFrame - frames, num, den)) // backward distance
      expect(tr.extended_us).toBe(0)
      for (const id of [a1, a2]) {
        expect(isCanonical(layerOf(p, id).t_start_us, num, den)).toBe(true)
        expect(isCanonical(layerOf(p, id).t_end_us, num, den)).toBe(true)
      }
      expect(overlapUs(p, tr)).toBe(tr.duration_us) // validate's overlap === duration rule
    }
  })

  it.each(RATES)('%i/%i: 1 frame / 10 s / 10 min / 1 h / 24 h durations all land on whole frames', (num, den) => {
    const requests = [timeUsAtFrame(1, num, den), 10_000_000, 600_000_000, 3_600_000_000, 86_400_000_000]
    for (const requestedUs of requests) {
      const frames = frameIndexRound(requestedUs, num, den)
      const cutFrame = frames + 10 // both layers longer than the overlap
      const { p, gen, a1, a2 } = adjacentAt(num, den, cutFrame, cutFrame)
      const tid = addT(p, gen, a1, a2, requestedUs, 'extend')
      expectOnGrid(p, tid, num, den, cutFrame, requestedUs)
    }
  })

  it.each(RATES)('%i/%i: update_transition snaps the new duration; both moved edges stay canonical', (num, den) => {
    const cutFrame = 60
    const { p, gen, a1, a2 } = adjacentAt(num, den, cutFrame, 60)
    const tid = addT(p, gen, a1, a2, 500_000, 'extend')
    // Grow then shrink then an explicit-borrow patch: every window the routing
    // can produce spans whole frames between canonical endpoints.
    for (const patch of [{ duration_us: 777_777 }, { duration_us: 250_001 }, { duration_us: 500_000, extended_us: 250_001 }]) {
      applyUpdateTransition(p, tid, patch)
      expectWindowOnGrid(p, tid, num, den, patch.duration_us)
    }
  })

  it.each(RATES)('%i/%i: extend add → grow → explicit borrow → shrink → remove is the identity on BOTH layers', (num, den) => {
    // The inverse-op round-trip (ADR 0048): the sacred end never moves, so remove
    // restores adjacency exactly — at fractional rates too, where any bare-µs
    // arithmetic would drift ±1 µs per hop.
    const { p, gen, a1, a2 } = adjacentAt(num, den, 61, 60)
    const before = [layerOf(p, a1).t_start_us, layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]
    const tid = addT(p, gen, a1, a2, 500_000, 'extend')
    applyUpdateTransition(p, tid, { duration_us: 777_777 })                          // B left
    applyUpdateTransition(p, tid, { duration_us: 777_777, extended_us: 300_000 })    // borrow returns partially, B follows
    applyUpdateTransition(p, tid, { duration_us: 250_001 })                          // borrow drains, B right
    applyRemoveTransition(p, tid)
    expect([layerOf(p, a1).t_start_us, layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]).toEqual(before)
    // Adjacency restored EXACTLY: B.start′ = S = A.end′.
    expect(layerOf(p, a2).t_start_us).toBe(layerOf(p, a1).t_end_us)
  })

  it.each(RATES)('%i/%i: overlap add → remove is the identity on BOTH layers (e = 0 routes the whole restore through B)', (num, den) => {
    const { p, gen, a1, a2 } = adjacentAt(num, den, 61, 60)
    const before = [layerOf(p, a1).t_start_us, layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]
    const tid = addT(p, gen, a1, a2, 500_000)
    applyRemoveTransition(p, tid)
    expect([layerOf(p, a1).t_start_us, layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]).toEqual(before)
    expect(layerOf(p, a2).t_start_us).toBe(layerOf(p, a1).t_end_us)
  })

  it.each(RATES)('%i/%i: a duration under half a frame fails InvalidArgument — never a 0-length transition', (num, den) => {
    const { p, gen, a1, a2 } = adjacentAt(num, den, 60, 60)
    const before = layerOf(p, a1).t_end_us
    // `ceil(canonical(1) / 2) - 1` is under half a frame at every rate here.
    for (const requestedUs of [1, Math.ceil(timeUsAtFrame(1, num, den) / 2) - 1]) {
      // Both placements refuse identically — the frames gate runs before the branch.
      for (const placement of ['overlap', 'extend'] as const) {
        const err = expectCmdErr(() => applyAddTransition(p, gen, a1, a2, requestedUs, CROSSFADE, placement))
        expect(err.error).toBe('InvalidArgument')
        expect(err.field).toBe('duration_us')
      }
    }
    expect([layerOf(p, a1).t_end_us, p.transitions.length]).toEqual([before, 0])
    // #6, not #7+ → neither rejection minted an id
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, timeUsAtFrame(30, num, den))).toBe('00000000-0000-0000-0000-000000000006')
  })

  it('30 fps half-frame boundary: 16666 µs is rejected, 16667 µs becomes exactly 1 frame (B moves left one frame)', () => {
    const { p, gen, a1, a2, cutUs } = adjacentAt(30, 1, 60, 60)
    expectCmd(() => applyAddTransition(p, gen, a1, a2, 16_666, CROSSFADE), 'InvalidArgument')
    const tid = addT(p, gen, a1, a2, 16_667)
    expect(p.transitions.find((t) => t.id === tid)!.duration_us).toBe(cutUs - timeUsAtFrame(59, 30, 1))
    expect(layerOf(p, a1).t_end_us).toBe(cutUs) // A untouched — overlap placement
    expect(layerOf(p, a2).t_start_us).toBe(timeUsAtFrame(59, 30, 1))
  })

  it('update_transition: a sub-half-frame request fails InvalidArgument and moves nothing', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    const err = expectCmdErr(() => applyUpdateTransition(p, tid, { duration_us: 16_666 }))
    expect([err.error, err.field]).toEqual(['InvalidArgument', 'duration_us'])
    expect([layerOf(p, a1).t_end_us, p.transitions[0].duration_us]).toEqual([3_000_000, 1_000_000])
  })

  it('a request that snaps to the CURRENT duration and extension is a full no-op (nothing moves)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    applyUpdateTransition(p, tid, { duration_us: 1_000_010 }) // same 30 frames at 30 fps
    applyUpdateTransition(p, tid, { duration_us: 999_995, extended_us: 1_000_012 }) // both round to the current values
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([3_000_000, 2_000_000])
    expect(p.transitions[0]).toMatchObject({ duration_us: 1_000_000, extended_us: 1_000_000 })
  })
})

describe('the tail-handle pre-check reads the SNAPPED duration', () => {
  it('accepts a request whose raw µs exceeds the handle but whose snapped duration fits', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_500_000) // handle = 500_000
    addT(p, gen, a1, a2, 510_000, 'extend') // snaps to 15 frames = 500_000
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_500_000, 2_500_000])
    expect(p.transitions[0].duration_us).toBe(500_000)
  })
  it('rejects a request whose raw µs fits but whose snapped duration does not', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_497_000) // handle = 497_000
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 495_000, CROSSFADE, 'extend'))) // snaps UP to 500_000
      .toEqual({ error: 'TransitionInsufficientHandle', layer: a1, available_us: 497_000 })
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_000_000, 2_000_000])
  })
})

describe('applyRemoveTransition', () => {
  it('full borrow (e = d, extend add): shrinks from_layer back; the incoming layer never moved so it stays', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
    applyRemoveTransition(p, tid)
    expect(layerOf(p, a1).t_end_us).toBe(2_000_000) // borrow returned exactly
    expect(layerOf(p, a2).t_start_us).toBe(2_000_000) // m = d − e = 0
    expect(p.transitions).toEqual([])
  })
  it('pure placement (e = 0): trims NOTHING off the outgoing layer; the incoming layer moves right by d', () => {
    // The live defect this routing fixes: the old remove unconditionally shrank
    // the outgoing tail, cutting real content on a pre-positioned overlap.
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a1).t_end_us = 3_000_000 // hand-positioned pre-overlap → e = 0
    const tid = addT(p, gen, a1, a2, 1_000_000)
    applyRemoveTransition(p, tid)
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // real content untouched
    expect([layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]).toEqual([3_000_000, 5_000_000])
    expect(layerOf(p, a2).t_start_us).toBe(layerOf(p, a1).t_end_us) // adjacency restored exactly
  })
  it('mixed provenance: returns e to the tail (src_out in sync) and moves the incoming layer right by d − e', () => {
    const { p, gen, a1, a2 } = videoThenColor(4_000_000)
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend') // A.end 3M, src_out 3M, e = 1M
    applyUpdateTransition(p, tid, { duration_us: 1_000_000, extended_us: 500_000 }) // A.end 2.5M, B.start 1.5M
    applyRemoveTransition(p, tid)
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_000_000, 2_000_000]) // back to the sacred end
    expect([layerOf(p, a2).t_start_us, layerOf(p, a2).t_end_us]).toEqual([2_000_000, 4_000_000]) // original geometry
  })
  it('unknown id → TransitionNotFound', () => {
    const { p } = twoAdjacent()
    expectCmd(() => applyRemoveTransition(p, 'ghost'), 'TransitionNotFound')
  })
})

describe('group siblings follow the incoming layer', () => {
  /** twoAdjacent + an audio sibling grouped with a2, slipped +500µs off a2's
   *  start — sample-aligned (500µs = 24 samples) but NOT frame-aligned, so any
   *  wrong-grid snap in the follow logic destroys the offset visibly. */
  function withSlippedSibling() {
    const base = twoAdjacent()
    addMedia(base.p, 'm', 'Audio', 10_000_000)
    const aud = applyAddLayer(base.p, base.gen, base.p.tracks[1].id, audioParams('m', 0, 2_000_000), 2_000_500, 4_000_500)
    base.p.groups.push({ id: 'g', members: [base.a2, aud].sort() })
    return { ...base, aud }
  }
  const offsetOf = (p: Project, aud: string, a2: string) => layerOf(p, aud).t_start_us - layerOf(p, a2).t_start_us

  it('overlap add: siblings shift by the SAME delta and land on their OWN lattice — the slipped offset survives the ADD itself', () => {
    const { p, gen, a1, a2, aud } = withSlippedSibling()
    const { bounces } = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(bounces).toEqual([]) // nothing occupies the sibling's shifted span
    expect(layerOf(p, a2).t_start_us).toBe(1_000_000)
    expect([layerOf(p, aud).t_start_us, layerOf(p, aud).t_end_us]).toEqual([1_000_500, 3_000_500])
    expect(offsetOf(p, aud, a2)).toBe(500) // slipped sync intact
  })
  it('update: siblings shift by the SAME delta and land on their OWN lattice — the slipped offset survives', () => {
    const { p, gen, a1, a2, aud } = withSlippedSibling()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    applyUpdateTransition(p, tid, { duration_us: 1_500_000 }) // growth → B moves left 500k
    expect(layerOf(p, a2).t_start_us).toBe(1_500_000)
    expect([layerOf(p, aud).t_start_us, layerOf(p, aud).t_end_us]).toEqual([1_500_500, 3_500_500])
    expect(offsetOf(p, aud, a2)).toBe(500) // slipped sync intact
  })
  it('remove: siblings follow the restore move by the same delta on their own lattice', () => {
    const { p, gen, a1, a2, aud } = withSlippedSibling()
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    applyUpdateTransition(p, tid, { duration_us: 1_500_000 }) // B at 1.5M, sibling at 1_500_500
    applyRemoveTransition(p, tid) // e = 1M, m = 500k → B back to 2M
    expect(layerOf(p, a2).t_start_us).toBe(2_000_000)
    expect(layerOf(p, a2).t_start_us).toBe(layerOf(p, a1).t_end_us) // adjacency exact
    expect([layerOf(p, aud).t_start_us, layerOf(p, aud).t_end_us]).toEqual([2_000_500, 4_000_500])
    expect(offsetOf(p, aud, a2)).toBe(500)
  })
})

describe('overlap add: sibling lane bounce (ADR 0042)', () => {
  /** twoAdjacent + an audio sibling of a2 on @B at [2M,4M] + a NON-moving audio
   *  blocker on the same lane at [1M,2M] — the sibling's 1M leftward shift lands
   *  it on [1M,3M], over the blocker. */
  function withBlockedSibling() {
    const base = twoAdjacent()
    addMedia(base.p, 'm', 'Audio', 10_000_000)
    const blocker = applyAddLayer(base.p, base.gen, base.p.tracks[1].id, audioParams('m', 0, 1_000_000), 1_000_000, 2_000_000) // #6
    const aud = applyAddLayer(base.p, base.gen, base.p.tracks[1].id, audioParams('m', 0, 2_000_000), 2_000_000, 4_000_000) // #7
    base.p.groups.push({ id: 'g', members: [base.a2, aud].sort() })
    return { ...base, blocker, aud }
  }

  it('a shifted sibling colliding on its lane bounces to an existing free overlay lane (spawned: false)', () => {
    const { p, gen, a1, a2, blocker, aud } = withBlockedSibling()
    const freeLane = applyAddTrack(p, gen, null) // #8 — role-less, empty
    const { bounces } = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE) // #9
    expect(bounces).toEqual([{ layer: aud, from_track: p.tracks[1].id, to_track: freeLane, spawned: false }])
    expect(p.tracks.find((t) => t.id === freeLane)!.layers.map((l) => l.id)).toEqual([aud])
    expect([layerOf(p, aud).t_start_us, layerOf(p, aud).t_end_us]).toEqual([1_000_000, 3_000_000]) // shifted span kept
    expect([layerOf(p, blocker).t_start_us, layerOf(p, blocker).t_end_us]).toEqual([1_000_000, 2_000_000]) // untouched
    expect(p.tracks[1].layers.map((l) => l.id)).toEqual([blocker]) // vacated lane keeps its blocker
  })

  it('no free lane → the bounce SPAWNS one (spawned: true); reserved lanes are never candidates', () => {
    const { p, gen, a1, a2, aud } = withBlockedSibling() // only the reserved A/B rolls exist
    const trackCountBefore = p.tracks.length
    const { bounces } = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(bounces).toHaveLength(1)
    expect(bounces[0]).toMatchObject({ layer: aud, from_track: p.tracks[1].id, spawned: true })
    expect(p.tracks.length).toBe(trackCountBefore + 1)
    const spawnedTrack = p.tracks.find((t) => t.id === bounces[0].to_track)!
    expect([spawnedTrack.role, spawnedTrack.transient]).toEqual([null, true])
    expect(spawnedTrack.layers.map((l) => l.id)).toEqual([aud])
  })

  it('a LOCKED free lane is never a bounce candidate — the bounce spawns instead of landing on it', () => {
    const { p, gen, a1, a2, aud } = withBlockedSibling()
    const lockedLane = applyAddTrack(p, gen, null) // #8 — free but locked
    p.tracks.find((t) => t.id === lockedLane)!.locked = true
    const { bounces } = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(bounces).toHaveLength(1)
    expect(bounces[0]).toMatchObject({ layer: aud, spawned: true })
    expect(bounces[0].to_track).not.toBe(lockedLane)
    expect(p.tracks.find((t) => t.id === lockedLane)!.layers).toEqual([]) // locked lane received nothing
  })

  it("the incoming layer B itself never bounces — its own-lane overlap with A is the transition's authorized window", () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    addT(p, gen, a1, a2, 1_000_000)
    // B stayed on its track over A's tail — the window, not a collision.
    expect(p.tracks[0].layers.map((l) => l.id)).toEqual([a1, a2])
  })
})

describe('applyRemoveTransition restore-collision pre-check', () => {
  it("the incoming layer's destination is occupied → TransitionRestoreCollision, NOTHING mutated", () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a1).t_end_us = 3_000_000 // pre-overlap → e = 0, restore moves B right by 1M
    const tid = addT(p, gen, a1, a2, 1_000_000)
    // The user filled the space B must move back through: D sits at [4M, 4.5M].
    applyAddLayer(p, gen, p.tracks[0].id, color(), 4_000_000, 4_500_000)
    expect(expectCmdErr(() => applyRemoveTransition(p, tid)))
      .toEqual({ error: 'TransitionRestoreCollision', layer: a2 })
    // Whole operation refused: the transition survives and no geometry moved.
    expect(p.transitions.map((t) => t.id)).toEqual([tid])
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([3_000_000, 2_000_000])
  })
  it("a group SIBLING's destination is occupied → TransitionRestoreCollision naming the sibling", () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a1).t_end_us = 3_000_000 // e = 0, m = 1M
    const tid = addT(p, gen, a1, a2, 1_000_000)
    addMedia(p, 'm', 'Audio', 10_000_000)
    const aud = applyAddLayer(p, gen, p.tracks[1].id, audioParams('m', 0, 2_000_000), 2_000_000, 4_000_000)
    const blocker = applyAddLayer(p, gen, p.tracks[1].id, audioParams('m', 0, 500_000), 4_500_000, 5_000_000)
    p.groups.push({ id: 'g', members: [a2, aud].sort() })
    expect(expectCmdErr(() => applyRemoveTransition(p, tid)))
      .toEqual({ error: 'TransitionRestoreCollision', layer: aud })
    expect(p.transitions.map((t) => t.id)).toEqual([tid])
    expect([layerOf(p, aud).t_start_us, layerOf(p, blocker).t_start_us]).toEqual([2_000_000, 4_500_000])
  })
  it('landing flush against the shrunk-back tail is NOT a collision (B.start′ = A.end′ by design)', () => {
    // The pre-check must judge against A's POST-restore end (S), or every
    // extend-flavoured remove with m > 0 would refuse against A's stale tail.
    const { p, gen, a1, a2 } = videoThenColor(4_000_000)
    const tid = addT(p, gen, a1, a2, 1_000_000, 'extend')
    applyUpdateTransition(p, tid, { duration_us: 1_000_000, extended_us: 500_000 }) // e = 500k, m = 500k
    expect(() => applyRemoveTransition(p, tid)).not.toThrow()
    expect(layerOf(p, a2).t_start_us).toBe(layerOf(p, a1).t_end_us)
  })
})

// ── Commit-level behavior of the B-move: validate backstop + reconcile ────────
// The mutation deliberately does NOT clamp or bounce a colliding/negative
// B-move (only remove pre-checks, with its own structured error); everything
// else is commit's validate refusing atomically, and a chained transition B→C
// broken by B's move is reconcile's designed drop.
describe('update_transition through the actor: backstop + chained reconcile', () => {
  function actorWith(layout: Array<[number, number]>) {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'tr')
    const logged: ActorLogEntry[] = []
    const actor = createActor({ initial, idGen, clock: () => '<TS>', emitLog: (e) => logged.push(e) })
    const track = initial.tracks[0].id
    const ids = layout.map(([s, e]) => {
      const r = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: s, t_end_us: e })
      if (!r.ok) throw new Error('seed add_layer failed')
      return r.value as string
    })
    return { actor, logged, track, ids }
  }

  it("a chained transition B→C broken by B's move is DROPPED by reconcile in the same commit, with a status row", () => {
    const { actor, logged, ids: [a, b, c] } = actorWith([[0, 2_000_000], [2_000_000, 4_000_000], [4_000_000, 6_000_000]])
    // Extend placement keeps all three layers in place, so the chain can be
    // authored at both cuts before the update breaks one of them.
    const t1 = (actor.dispatch('add_transition', { from: a, to: b, duration_us: 1_000_000, placement: 'extend' }) as { ok: true; value: string }).value // a → 3M
    const t2 = (actor.dispatch('add_transition', { from: b, to: c, duration_us: 1_000_000, placement: 'extend' }) as { ok: true; value: string }).value // b → 5M
    // Growing t1 moves B left by 1M: B [2M,5M] → [1M,4M]. Its overlap with C
    // collapses to zero, so t2's invariant breaks and reconcile drops it —
    // while t1's own geometry holds (overlap [1M,3M] = 2M = d′).
    expect(actor.dispatch('update_transition', { transition: t1, duration_us: 2_000_000 }).ok).toBe(true)
    expect(actor.snapshot().transitions.map((t) => t.id)).toEqual([t1])
    expect(logged).toHaveLength(1)
    expect(logged[0].details).toMatchObject({ kind: 'TransitionReconcileDrop', transition: t2 })
    // One undo restores the duration edit AND the dropped chained transition.
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().transitions.map((t) => t.id).sort()).toEqual([t1, t2].sort())
  })

  it("B's move onto an unrelated layer is refused ATOMICALLY by validate (LayerOverlap) — no clamp, no bounce", () => {
    // The default overlap add is already pure placement (e = 0, B at [1M, 3M]),
    // so shrinking moves B RIGHT, into D. Note D also blocks B's lane —
    // reconcile drops nothing here because t1's own overlap stays consistent;
    // the refusal is the overlap rule. (B is the moving layer itself, not a
    // group sibling, so the update path never bounces it — D2's bounce is for
    // siblings on OTHER lanes during the add.)
    const { actor, ids: [a, b] } = actorWith([[0, 2_000_000], [2_000_000, 4_000_000]])
    const t1 = (actor.dispatch('add_transition', { from: a, to: b, duration_us: 1_000_000 }) as { ok: true; value: string }).value
    // D fills the space to B's right.
    expect(actor.dispatch('add_layer', { track: actor.snapshot().tracks[0].id, kind: 'color', t_start_us: 3_000_000, t_end_us: 4_000_000 }).ok).toBe(true)
    const before = actor.snapshot()
    const r = actor.dispatch('update_transition', { transition: t1, duration_us: 500_000 }) // e = 0 → B moves right 500k, into D
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.error).toBe('ValidationFailed')
      expect((r.error as { error: 'ValidationFailed'; detail: { rule: string } }).detail.rule).toBe('LayerOverlap')
    }
    expect(actor.snapshot()).toBe(before) // atomic: the partial A/B geometry never landed
  })

  it("a group sibling pushed across t = 0 by B's leftward move is refused ATOMICALLY (NegativeLayerStart)", () => {
    const { actor, ids: [a, b] } = actorWith([[0, 2_000_000], [2_000_000, 4_000_000]])
    // Audio sibling near the origin on the B-roll, grouped with B. The add is
    // pinned to 'extend' so nothing moves at add time — the update's growth is
    // what pushes the set left (the ADD-time zero-cross has its own pre-mint
    // refusal, covered in the overlap-placement refusal suite above).
    expect(actor.dispatch('add_media', { id: 'm-aud', kind: 'Audio', duration_us: 10_000_000, with_audio: true }).ok).toBe(true)
    const aud = (actor.dispatch('add_layer', { track: actor.snapshot().tracks[1].id, kind: 'audio', media: 'm-aud', src_in_us: 0, src_out_us: 1_000_000, t_start_us: 300_000, t_end_us: 1_300_000 }) as { ok: true; value: string }).value
    expect(actor.dispatch('groups_create', { layers: [b, aud], label: null, reassign: false }).ok).toBe(true)
    const t1 = (actor.dispatch('add_transition', { from: a, to: b, duration_us: 1_000_000, placement: 'extend' }) as { ok: true; value: string }).value
    const before = actor.snapshot()
    // Growth moves B (and the sibling) left by 500k → sibling start −200k.
    const r = actor.dispatch('update_transition', { transition: t1, duration_us: 1_500_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.error).toBe('ValidationFailed')
      expect((r.error as { error: 'ValidationFailed'; detail: { rule: string; layer: string } }).detail).toMatchObject({ rule: 'NegativeLayerStart', layer: aud })
    }
    expect(actor.snapshot()).toBe(before)
  })

  it('an overlap add whose sibling bounces emits ONE TransitionPlacementBounce status row and still returns the transition id', () => {
    const { actor, logged, ids: [a, b] } = actorWith([[0, 2_000_000], [2_000_000, 4_000_000]])
    const bRoll = actor.snapshot().tracks[1].id
    expect(actor.dispatch('add_media', { id: 'm-aud', kind: 'Audio', duration_us: 10_000_000, with_audio: true }).ok).toBe(true)
    // Sibling of B at [2M,4M] on the B-roll audio lane; a non-moving blocker at [1M,2M].
    const blocker = (actor.dispatch('add_layer', { track: bRoll, kind: 'audio', media: 'm-aud', src_in_us: 0, src_out_us: 1_000_000, t_start_us: 1_000_000, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const aud = (actor.dispatch('add_layer', { track: bRoll, kind: 'audio', media: 'm-aud', src_in_us: 0, src_out_us: 2_000_000, t_start_us: 2_000_000, t_end_us: 4_000_000 }) as { ok: true; value: string }).value
    expect(actor.dispatch('groups_create', { layers: [b, aud], label: null, reassign: false }).ok).toBe(true)
    const r = actor.dispatch('add_transition', { from: a, to: b, duration_us: 1_000_000 })
    expect(r.ok).toBe(true)
    const tid = (r as { ok: true; value: string }).value // wire shape unchanged: the value IS the id
    expect(actor.snapshot().transitions.map((t) => t.id)).toEqual([tid])
    // The bounce reached the LogBus seam — same emitLog row pattern as reconcile drops.
    expect(logged).toHaveLength(1)
    expect(logged[0].level).toBe('info')
    expect(logged[0].category).toEqual({ kind: 'Project' })
    expect(logged[0].message).toContain(aud)
    expect(logged[0].details).toMatchObject({ kind: 'TransitionPlacementBounce', layer: aud, from_track: bRoll, spawned: true })
    // And the bounce itself landed: aud on the spawned lane, blocker untouched.
    const spawnedId = (logged[0].details as { to_track: string }).to_track
    const spawned = actor.snapshot().tracks.find((t) => t.id === spawnedId)!
    expect(spawned.layers.map((l) => l.id)).toEqual([aud])
    expect(actor.snapshot().tracks.find((t) => t.id === bRoll)!.layers.map((l) => l.id)).toEqual([blocker])
    // ONE undo restores the whole placement — shift, bounce, spawned lane and all.
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
    expect(actor.snapshot().tracks.some((t) => t.id === spawnedId)).toBe(false)
    expect(actor.snapshot().tracks.find((t) => t.id === bRoll)!.layers.map((l) => l.id)).toEqual([blocker, aud])
  })

  it('an overlap add refused for a shared group burns NO op_id and surfaces the structured error through dispatch', () => {
    const { actor, ids: [a, b] } = actorWith([[0, 2_000_000], [2_000_000, 4_000_000]])
    expect(actor.dispatch('groups_create', { layers: [a, b], label: null, reassign: false }).ok).toBe(true)
    const before = actor.snapshot()
    const historyBefore = actor.historyStatus().len
    const r = actor.dispatch('add_transition', { from: a, to: b, duration_us: 1_000_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toEqual({ error: 'TransitionParticipantsShareGroup', from: a, to: b })
    expect(actor.snapshot()).toBe(before)
    expect(actor.historyStatus().len).toBe(historyBefore)
  })

  it("dispatch rejects an unknown placement enum value pre-commit (InvalidArgument, field 'placement')", () => {
    const { actor, ids: [a, b] } = actorWith([[0, 2_000_000], [2_000_000, 4_000_000]])
    const r = actor.dispatch('add_transition', { from: a, to: b, duration_us: 1_000_000, placement: 'diagonal' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect([r.error.error, (r.error as { field?: string }).field]).toEqual(['InvalidArgument', 'placement'])
    expect(actor.snapshot().transitions).toEqual([])
  })
})

describe('locked home lane refuses every transition op (TrackLocked)', () => {
  // Transitions are the one mutation family whose subject is not a layer, so
  // the move/trim/split lock convention lands as a whole-command gate — the
  // ungrouped incoming layer included, which checkGroupLock alone would miss.
  it('add refuses under BOTH placements: no id burned, geometry untouched', () => {
    for (const placement of ['overlap', 'extend'] as const) {
      const { p, gen, a1, a2 } = twoAdjacent()
      p.tracks[0].locked = true
      expectCmd(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE, placement), 'TrackLocked')
      expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us], placement).toEqual([2_000_000, 2_000_000])
      expect(p.transitions, placement).toEqual([])
      expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000), placement)
        .toBe('00000000-0000-0000-0000-000000000006') // #6, not #7 → no burn
    }
  })
  it('update refuses the WHOLE patch — a kind-only change is no exception (locked means untouchable)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000) // #6, added while unlocked
    p.tracks[0].locked = true
    expectCmd(() => applyUpdateTransition(p, tid, { duration_us: 1_500_000 }), 'TrackLocked')
    expectCmd(() => applyUpdateTransition(p, tid, { kind: { kind: 'Wipe', direction: 'left' } }), 'TrackLocked')
    expect(p.transitions[0].kind).toEqual(CROSSFADE)
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([2_000_000, 1_000_000])
  })
  it('remove refuses too — unlocking first is the road back, matching every other edit on the lane', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = addT(p, gen, a1, a2, 1_000_000)
    p.tracks[0].locked = true
    expectCmd(() => applyRemoveTransition(p, tid), 'TrackLocked')
    expect(p.transitions.map((t) => t.id)).toEqual([tid])
    expect([layerOf(p, a1).t_end_us, layerOf(p, a2).t_start_us]).toEqual([2_000_000, 1_000_000])
  })
})
