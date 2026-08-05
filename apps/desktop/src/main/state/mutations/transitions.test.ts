import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project, type Transition } from '../model'
import { applyAddLayer, colorParams, defaultTransform, textParamsDefault } from './add'
import { extendLayerTEnd, shrinkLayerTEnd, applyAddTransition, applyRemoveTransition, applyUpdateTransition } from './transitions'
import { frameIndexRound, timeUsAtFrame } from '../snap'
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
/** The three properties ticket 04 buys, asserted together. */
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
  it.each(RATES)('%i/%i: an off-grid add_transition duration snaps to whole frames at every cut phase', (num, den) => {
    // Several cut phases: at 1001-denominator rates the ±1 µs error in
    // `canonical(k) + canonical(n)` depends on k, so one phase proves nothing.
    for (const cutFrame of [60, 61, 67, 601]) {
      const { p, gen, a1, a2 } = adjacentAt(num, den, cutFrame, 60)
      const tid = applyAddTransition(p, gen, a1, a2, 500_000, CROSSFADE)
      expectOnGrid(p, tid, num, den, cutFrame, 500_000)
      expect(layerOf(p, a1).t_end_us).toBe(timeUsAtFrame(cutFrame + frameIndexRound(500_000, num, den), num, den))
    }
  })

  it.each(RATES)('%i/%i: 1 frame / 10 s / 10 min / 1 h / 24 h durations all land on whole frames', (num, den) => {
    const requests = [timeUsAtFrame(1, num, den), 10_000_000, 600_000_000, 3_600_000_000, 86_400_000_000]
    for (const requestedUs of requests) {
      const frames = frameIndexRound(requestedUs, num, den)
      const cutFrame = frames + 10 // both layers longer than the overlap
      const { p, gen, a1, a2 } = adjacentAt(num, den, cutFrame, cutFrame)
      const tid = applyAddTransition(p, gen, a1, a2, requestedUs, CROSSFADE)
      expectOnGrid(p, tid, num, den, cutFrame, requestedUs)
    }
  })

  it.each(RATES)('%i/%i: update_transition snaps the new duration; grow and shrink keep the endpoint canonical', (num, den) => {
    const cutFrame = 60
    const { p, gen, a1, a2 } = adjacentAt(num, den, cutFrame, 60)
    const tid = applyAddTransition(p, gen, a1, a2, 500_000, CROSSFADE)
    for (const requestedUs of [777_777, 250_001]) {
      applyUpdateTransition(p, tid, { duration_us: requestedUs })
      expectOnGrid(p, tid, num, den, cutFrame, requestedUs)
    }
  })

  it.each(RATES)('%i/%i: add then remove restores the exact original endpoint', (num, den) => {
    const { p, gen, a1, a2 } = adjacentAt(num, den, 60, 60)
    const before = layerOf(p, a1).t_end_us
    applyRemoveTransition(p, applyAddTransition(p, gen, a1, a2, 500_000, CROSSFADE))
    expect(layerOf(p, a1).t_end_us).toBe(before)
  })

  it.each(RATES)('%i/%i: a duration under half a frame fails InvalidArgument — never a 0-length transition', (num, den) => {
    const { p, gen, a1, a2 } = adjacentAt(num, den, 60, 60)
    const before = layerOf(p, a1).t_end_us
    // `ceil(canonical(1) / 2) - 1` is under half a frame at every rate here.
    for (const requestedUs of [1, Math.ceil(timeUsAtFrame(1, num, den) / 2) - 1]) {
      const err = expectCmdErr(() => applyAddTransition(p, gen, a1, a2, requestedUs, CROSSFADE))
      expect(err.error).toBe('InvalidArgument')
      expect(err.field).toBe('duration_us')
    }
    expect([layerOf(p, a1).t_end_us, p.transitions.length]).toEqual([before, 0])
    // #6, not #7+ → neither rejection minted an id
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, timeUsAtFrame(30, num, den))).toBe('00000000-0000-0000-0000-000000000006')
  })

  it('30 fps half-frame boundary: 16666 µs is rejected, 16667 µs becomes exactly 1 frame', () => {
    const { p, gen, a1, a2, cutUs } = adjacentAt(30, 1, 60, 60)
    expectCmd(() => applyAddTransition(p, gen, a1, a2, 16_666, CROSSFADE), 'InvalidArgument')
    const tid = applyAddTransition(p, gen, a1, a2, 16_667, CROSSFADE)
    expect(p.transitions.find((t) => t.id === tid)!.duration_us).toBe(timeUsAtFrame(61, 30, 1) - cutUs)
    expect(layerOf(p, a1).t_end_us).toBe(timeUsAtFrame(61, 30, 1))
  })

  it('update_transition: a sub-half-frame request fails InvalidArgument and moves nothing', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    const err = expectCmdErr(() => applyUpdateTransition(p, tid, { duration_us: 16_666 }))
    expect([err.error, err.field]).toEqual(['InvalidArgument', 'duration_us'])
    expect([layerOf(p, a1).t_end_us, p.transitions[0].duration_us]).toEqual([3_000_000, 1_000_000])
  })

  it('a request that snaps to the CURRENT duration is a no-op (no tail movement)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    applyUpdateTransition(p, tid, { duration_us: 1_000_010 }) // same 30 frames at 30 fps
    expect([layerOf(p, a1).t_end_us, p.transitions[0].duration_us]).toEqual([3_000_000, 1_000_000])
  })
})

describe('the tail-handle pre-check reads the SNAPPED duration', () => {
  it('accepts a request whose raw µs exceeds the handle but whose snapped duration fits', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_500_000) // handle = 500_000
    applyAddTransition(p, gen, a1, a2, 510_000, CROSSFADE) // snaps to 15 frames = 500_000
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_500_000, 2_500_000])
    expect(p.transitions[0].duration_us).toBe(500_000)
  })
  it('rejects a request whose raw µs fits but whose snapped duration does not', () => {
    const { p, gen, a1, a2 } = videoThenColor(2_497_000) // handle = 497_000
    expect(expectCmdErr(() => applyAddTransition(p, gen, a1, a2, 495_000, CROSSFADE))) // snaps UP to 500_000
      .toEqual({ error: 'TransitionInsufficientHandle', layer: a1, available_us: 497_000 })
    expect([layerOf(p, a1).t_end_us, srcOutOf(p, a1)]).toEqual([2_000_000, 2_000_000])
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
