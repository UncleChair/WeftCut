import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyAddLayer, colorParams, defaultTransform, textParamsDefault } from './add'
import { extendLayerTEnd, shrinkLayerTEnd, applyAddTransition, applyRemoveTransition, applyUpdateTransition } from './transitions'
import { isCommandFailure } from '../errors'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const CROSSFADE = { kind: 'Crossfade' as const }
const color = () => colorParams(RED, 1920, 1080)

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
          rotation_deg: { mode: 'Static', value: 0 }, anchor: [0.5, 0.5] },
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
  it('adjacent layers: extends from_layer and adds the transition (id #6)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE) // #6
    expect(tid).toBe('00000000-0000-0000-0000-000000000006')
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // extended by 1M
    expect(p.transitions).toEqual([{ id: tid, from_layer: a1, to_layer: a2, duration_us: 1_000_000, kind: CROSSFADE }])
  })
  it('already overlapping by exactly duration: no extension, just adds (case 2)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a1).t_end_us = 3_000_000 // hand-position a pre-overlap of 1M (unreachable via the API)
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // unchanged
    expect(p.transitions.map((t) => t.id)).toEqual([tid])
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

describe('applyAddTransition tail-handle pre-check (adjacent case only)', () => {
  it('insufficient handle → TransitionInsufficientHandle with available_us; geometry untouched; NO id burned', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_500_000) // handle = 2.5M − src_out 2M = 500k
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)))
      .toEqual({ error: 'TransitionInsufficientHandle', layer: a1, available_us: 500_000 })
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_000_000, 2_000_000]) // untouched
    expect(p.transitions).toEqual([])
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6, not #7 → no burn
  })
  it('exact-fit handle (available === duration) succeeds', () => {
    const { p, gen, a1, a2 } = videoThenColor(3_000_000) // handle = 1M
    applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([3_000_000, 3_000_000])
  })
  it('null media duration = unknowable → unlimited (mirrors SrcRangeExceedsMedia firing only on non-null)', () => {
    const { p, gen, a1, a2 } = videoThenColor(null)
    expect(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)).not.toThrow()
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
  })
  it('free-duration outgoing (Text) has unlimited handle', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const a1 = applyAddLayer(p, gen, p.tracks[0].id, textParamsDefault('hi'), 0, 2_000_000)
    const a2 = applyAddLayer(p, gen, p.tracks[0].id, color(), 2_000_000, 4_000_000)
    applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
  })
  it('pre-positioned overlap extends nothing → no handle pre-check even at zero handle', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_000_000) // handle = 0
    layerOf(p, a1).t_end_us = 3_000_000 // hand-position a pre-overlap of 1M (unreachable via the API)
    expect(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)).not.toThrow()
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

describe('applyUpdateTransition', () => {
  it('grows duration: extends from_layer tail, updates duration_us', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE) // a1 → 3M
    applyUpdateTransition(p, tid, { duration_us: 1_500_000 })
    expect(layerOf(p, a1).t_end_us).toBe(3_500_000)
    expect(p.transitions[0].duration_us).toBe(1_500_000)
  })
  it('shrinks duration: pulls from_layer tail back', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    applyUpdateTransition(p, tid, { duration_us: 400_000 })
    expect(layerOf(p, a1).t_end_us).toBe(2_400_000)
    expect(p.transitions[0].duration_us).toBe(400_000)
  })
  it('kind-only patch is a pure field swap — geometry untouched', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    applyUpdateTransition(p, tid, { kind: { kind: 'Wipe', direction: 'left' } })
    expect(p.transitions[0].kind).toEqual({ kind: 'Wipe', direction: 'left' })
    expect([layerOf(p, a1).t_end_us, p.transitions[0].duration_us]).toEqual([3_000_000, 1_000_000])
  })
  it('one patch may change duration AND kind together', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    applyUpdateTransition(p, tid, { duration_us: 500_000, kind: { kind: 'Slide', direction: 'up' } })
    expect(layerOf(p, a1).t_end_us).toBe(2_500_000)
    expect(p.transitions[0]).toEqual({ id: tid, from_layer: a1, to_layer: a2, duration_us: 500_000, kind: { kind: 'Slide', direction: 'up' } })
  })
  it('growth re-checks the handle (available = media duration − CURRENT src_out); state untouched on failure', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_500_000) // handle 500k
    const tid = applyAddTransition(p, gen, a1, a2, 500_000, CROSSFADE) // consumes it all: src_out → 2.5M
    expect(expectCmdErr(() => applyUpdateTransition(p, tid, { duration_us: 1_000_000 })))
      .toEqual({ error: 'TransitionInsufficientHandle', layer: a1, available_us: 0 })
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1), p.transitions[0].duration_us]).toEqual([2_500_000, 2_500_000, 500_000])
  })
  it('growth within the handle extends src_out_us too', () => {
    const { p, gen, a1, a2 } = videoThenColor(4_000_000) // handle 2M
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE) // src_out → 3M
    applyUpdateTransition(p, tid, { duration_us: 1_500_000 }) // delta 500k ≤ 4M − 3M
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([3_500_000, 3_500_000])
  })
  it('duration must stay > 0 → ValidationFailed(TransitionDurationOutOfRange); geometry untouched', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(expectCmdErr(() => applyUpdateTransition(p, tid, { duration_us: 0 })))
      .toEqual({ error: 'ValidationFailed', detail: { rule: 'TransitionDurationOutOfRange', transition: tid, duration: 0 } })
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
  })
  it('empty and same-duration patches are no-ops', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    applyUpdateTransition(p, tid, {})
    applyUpdateTransition(p, tid, { duration_us: 1_000_000 })
    expect([layerOf(p, a1).t_end_us, p.transitions[0].duration_us]).toEqual([3_000_000, 1_000_000])
  })
  it('unknown id → TransitionNotFound', () => {
    const { p } = twoAdjacent()
    expectCmd(() => applyUpdateTransition(p, 'ghost', { duration_us: 500_000 }), 'TransitionNotFound')
  })
})

describe('applyRemoveTransition', () => {
  it('shrinks from_layer back and removes the transition', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
    applyRemoveTransition(p, tid)
    expect(layerOf(p, a1).t_end_us).toBe(2_000_000) // shrunk back
    expect(p.transitions).toEqual([])
  })
  it('unknown id → TransitionNotFound', () => {
    const { p } = twoAdjacent()
    expectCmd(() => applyRemoveTransition(p, 'ghost'), 'TransitionNotFound')
  })
})
