// apps/desktop/src/main/state/mutations/trim.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type MediaItem, type Project } from '../model'
import { applyAddLayer, colorParams } from './add'
import { applyTrimLayer, clampSigned } from './trim'
import { isCommandFailure } from '../errors'
import { validate } from '../validate'
import { applyGroupsCreate } from './groups'
import { frameCount, frameIndexFloor, frameIndexRound, timeUsAtFrame } from '../../../renderer/frames'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function video(id: string, media: string, t0: number, t1: number, srcIn: number, srcOut: number): Layer {
  const params: LayerParams = {
    kind: 'VideoClip', media, src_in_us: srcIn, src_out_us: srcOut,
    transform: {
      x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 },
      scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 },
      rotation_deg: { mode: 'Static', value: 0 }, anchor: [0.5, 0.5],
    },
    opacity: { mode: 'Static', value: 1 }, crop: null, flip_h: false, flip_v: false,
    blend_mode: 'Normal', speed: 1, fade_in_us: 0, fade_out_us: 0,
  }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function media(id: string, durationUs: number): MediaItem {
  return {
    id, label: null, path_abs: '/m.mp4', path_rel: null, kind: 'Video',
    metadata: { duration_us: durationUs, video: null, audio: null, container_format: null },
    file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '<TS>',
    decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
}

function setup() {
  const g = seededGen(); const p = blankProject(g, 't')
  const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 1_000_000, 3_000_000)
  return { p, a }
}
describe('trim', () => {
  it('clampSigned collapses inverted bounds to 0', () => {
    expect(clampSigned(50, -10, 10)).toBe(10)
    expect(clampSigned(-50, -10, 10)).toBe(-10)
    expect(clampSigned(5, 10, -10)).toBe(0)
  })
  it('trims the IN edge later (shortening)', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'In', 1_500_000, false)
    const l = p.tracks[0].layers.find((x) => x.id === a)!
    expect(l.t_start_us).toBe(1_500_000); expect(l.t_end_us).toBe(3_000_000)
  })
  // Ticket 03 (`.scratch/timeline-frame-grid`): the cap used to be `dur - 1`, so an
  // over-trim landed a 1 µs off-grid sliver that validate's `start < end` accepted.
  // The floor is now one composition frame and both edges stay canonical.
  it('clamps an IN over-trim to one composition frame, not one microsecond', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'In', 9_000_000, false) // way past t_end
    const l = p.tracks[0].layers.find((x) => x.id === a)!
    expect(l.t_start_us).toBe(2_966_667) // frame 89 at 30/1 — frame 90 is t_end
    expect(l.t_end_us - l.t_start_us).toBe(33_333)
  })
  it('trims the OUT edge, and clamps an inverting OUT trim to one frame (ticket 03)', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'Out', 4_000_000, false)
    expect(p.tracks[0].layers.find((x) => x.id === a)!.t_end_us).toBe(4_000_000)
    // Trimming OUT to the current end returns via the no-op path, NOT an error.
    // Trimming OUT down to t_start would invert: clamped to the frame after t_start
    // (was t_start + 1 µs before ticket 03).
    const { p: p2, a: a2 } = setup()
    applyTrimLayer(p2, a2, 'Out', 1_000_000, false)
    const l2 = p2.tracks[0].layers.find((x) => x.id === a2)!
    expect(l2.t_start_us).toBe(1_000_000)
    expect(l2.t_end_us).toBe(1_033_333) // frame 31 at 30/1
  })
  it.each([
    ['In', 2_966_667],
    ['Out', 1_033_333],
  ] as const)('accepts a one-frame %s trim from the timeline UI', (edge, atUs) => {
    const { p, a } = setup()
    applyTrimLayer(p, a, edge, atUs, false)
    const l = p.tracks[0].layers.find((x) => x.id === a)!
    expect(l.t_end_us - l.t_start_us).toBe(33_333)
  })
  it('clamps an AV OUT trim at normalized media duration', () => {
    const p = blankProject(seededGen(), 't')
    p.media_pool.m = media('m', 2_000_000)
    p.tracks[0].layers = [video('v', 'm', 0, 1_000_000, 0, 1_000_000)]
    applyTrimLayer(p, 'v', 'Out', 3_000_000, false)
    const l = p.tracks[0].layers[0]
    expect(l.t_end_us).toBe(2_000_000)
    expect(l.params.kind).toBe('VideoClip')
    if (l.params.kind === 'VideoClip') expect(l.params.src_out_us).toBe(2_000_000)
  })
  it('rejects a locked track', () => {
    const { p, a } = setup(); p.tracks[0].locked = true
    try { applyTrimLayer(p, a, 'In', 1_500_000, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})

// ── Ticket 03: trim bounds live in composition-frame space ───────────────────
// Every clamp path must land a canonical endpoint (`timeUsAtFrame(i)`) and leave
// at least one whole frame, at every rate in the spec matrix — the two rational
// families are where a µs-based bound used to go off grid.

const RATES: ReadonlyArray<readonly [number, number]> = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001],
  [30, 1], [50, 1], [60000, 1001], [60, 1],
]

/** A time is canonical iff it IS the µs of some frame index (spec: the invariant). */
function expectCanonical(us: number, num: number, den: number): void {
  expect(us).toBe(timeUsAtFrame(frameIndexRound(us, num, den), num, den))
}

function projectAtRate(num: number, den: number): Project {
  const p = blankProject(seededGen(), 't')
  p.composition.fps = { num, den }
  return p
}

/** An arbitrary media duration that is NOT a frame boundary at any rate in the
 *  matrix — the UI-reachable half of the bug (drag the Out edge past media end). */
const OFF_GRID_MEDIA_DUR = 10_000_123

describe.each(RATES)('trim bounds on the %s/%s grid', (num, den) => {
  const at = (f: number) => timeUsAtFrame(f, num, den)

  it.each([
    ['requested delta == duration exactly', 0],
    ['requested delta far beyond the layer', 600],
  ] as const)('over-trimming IN leaves one canonical frame (%s)', (_label, over) => {
    const p = projectAtRate(num, den)
    p.tracks[0].layers = [color('a', at(30), at(120))]
    applyTrimLayer(p, 'a', 'In', at(120 + over), false)
    const l = p.tracks[0].layers[0]
    expect(l.t_start_us).toBe(at(119))
    expect(l.t_end_us).toBe(at(120))
    expectCanonical(l.t_start_us, num, den)
    expect(frameCount(l.t_start_us, l.t_end_us, num, den)).toBe(1)
  })

  // Frame indices, not µs: an `it.each` table is built at COLLECTION time, before
  // the wasm grid is initialized (`renderer/testSetup.ts` inits in `beforeAll`).
  it.each([
    ['requested delta == duration exactly', 30],
    ['requested delta far beyond the layer', -600],
  ] as const)('over-trimming OUT leaves one canonical frame (%s)', (_label, targetFrame) => {
    const p = projectAtRate(num, den)
    p.tracks[0].layers = [color('a', at(30), at(120))]
    applyTrimLayer(p, 'a', 'Out', Math.max(0, at(targetFrame)), false)
    const l = p.tracks[0].layers[0]
    expect(l.t_start_us).toBe(at(30))
    expect(l.t_end_us).toBe(at(31))
    expectCanonical(l.t_end_us, num, den)
    expect(frameCount(l.t_start_us, l.t_end_us, num, den)).toBe(1)
  })

  it('clamps an IN growth past composition zero to frame 0', () => {
    const p = projectAtRate(num, den)
    p.tracks[0].layers = [color('a', at(30), at(120))]
    applyTrimLayer(p, 'a', 'In', at(-150), false) // before the composition start
    const l = p.tracks[0].layers[0]
    expect(l.t_start_us).toBe(0)
    expect(l.t_end_us).toBe(at(120))
  })

  it('OUT-trims to the last whole frame inside an off-grid media duration', () => {
    const p = projectAtRate(num, den)
    p.media_pool.m = media('m', OFF_GRID_MEDIA_DUR)
    p.tracks[0].layers = [video('v', 'm', 0, at(30), 0, at(30))]
    applyTrimLayer(p, 'v', 'Out', 60_000_000, false)
    const l = p.tracks[0].layers[0]
    const lastIdx = frameIndexFloor(OFF_GRID_MEDIA_DUR, num, den)
    const lastWhole = timeUsAtFrame(lastIdx, num, den)
    expect(l.t_end_us).toBe(lastWhole)
    expectCanonical(l.t_end_us, num, den)
    // ...and it really is the LAST frame inside the media, not an early stop.
    expect(lastWhole).toBeLessThanOrEqual(OFF_GRID_MEDIA_DUR)
    expect(timeUsAtFrame(lastIdx + 1, num, den)).toBeGreaterThan(OFF_GRID_MEDIA_DUR)
    if (l.params.kind === 'VideoClip') {
      expect(l.params.src_out_us).toBe(lastWhole)
      expect(l.params.src_out_us).toBeLessThanOrEqual(OFF_GRID_MEDIA_DUR)
    }
    expect(() => validate(p)).not.toThrow() // SrcRangeExceedsMedia still clean
  })

  it.each([
    ['In', 11],
    ['Out', 10],
  ] as const)('refuses to trim a one-frame clip inward at the %s edge', (edge, targetFrame) => {
    const p = projectAtRate(num, den)
    p.tracks[0].layers = [color('a', at(10), at(11))]
    try {
      applyTrimLayer(p, 'a', edge, at(targetFrame), false)
      throw new Error('expected TrimEdgeOutOfRange')
    } catch (e) {
      expect(isCommandFailure(e) && e.err.error).toBe('TrimEdgeOutOfRange')
    }
    expect(p.tracks[0].layers[0].t_start_us).toBe(at(10)) // no partial commit
    expect(p.tracks[0].layers[0].t_end_us).toBe(at(11))
  })

  it.each([
    ['In', 9, 9, 11],
    ['Out', 12, 10, 12],
  ] as const)('grows a one-frame clip to exactly two frames at the %s edge', (edge, target, f0, f1) => {
    const p = projectAtRate(num, den)
    p.tracks[0].layers = [color('a', at(10), at(11))]
    applyTrimLayer(p, 'a', edge, at(target), false)
    const l = p.tracks[0].layers[0]
    expect([l.t_start_us, l.t_end_us]).toEqual([at(f0), at(f1)])
    expect(frameCount(l.t_start_us, l.t_end_us, num, den)).toBe(2)
  })

  it('clamps a group-aligned OUT over-trim at the tightest member, on grid', () => {
    const p = projectAtRate(num, den)
    p.tracks[0].layers = [color('a', at(0), at(90))]
    p.tracks[1].layers = [color('b', at(60), at(90))] // shorter → governs
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyTrimLayer(p, 'a', 'Out', 0, false)
    for (const l of [p.tracks[0].layers[0], p.tracks[1].layers[0]]) {
      expect(l.t_end_us).toBe(at(61))
      expectCanonical(l.t_end_us, num, den)
    }
    expect(p.tracks[1].layers[0].t_start_us).toBe(at(60)) // tightest = one frame
  })

  it('clamps a group-aligned IN over-trim at the tightest member, on grid', () => {
    const p = projectAtRate(num, den)
    p.tracks[0].layers = [color('a', at(30), at(120))]
    p.tracks[1].layers = [color('b', at(30), at(60))] // shorter → governs
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyTrimLayer(p, 'a', 'In', at(500), false)
    for (const l of [p.tracks[0].layers[0], p.tracks[1].layers[0]]) {
      expect(l.t_start_us).toBe(at(59))
      expectCanonical(l.t_start_us, num, den)
    }
    expect(p.tracks[1].layers[0].t_end_us).toBe(at(60)) // tightest = one frame
  })

  it('clamps a group-aligned OUT growth at the media-capped member, on grid', () => {
    const p = projectAtRate(num, den)
    p.media_pool.m = media('m', OFF_GRID_MEDIA_DUR)
    p.tracks[0].layers = [color('a', 0, at(30))]
    p.tracks[1].layers = [video('v', 'm', 0, at(30), 0, at(30))]
    applyGroupsCreate(p, seededGen(), ['a', 'v'], null, false)
    applyTrimLayer(p, 'a', 'Out', 60_000_000, false)
    const lastWhole = timeUsAtFrame(frameIndexFloor(OFF_GRID_MEDIA_DUR, num, den), num, den)
    for (const l of [p.tracks[0].layers[0], p.tracks[1].layers[0]]) {
      expect(l.t_end_us).toBe(lastWhole)
      expectCanonical(l.t_end_us, num, den)
    }
    expect(() => validate(p)).not.toThrow()
  })

  it('keeps src_in/src_out unsnapped while the timeline edge lands on grid', () => {
    const p = projectAtRate(num, den)
    p.media_pool.m = media('m', OFF_GRID_MEDIA_DUR)
    // src range deliberately off-grid: it is source-media time (spec: NOT snapped).
    p.tracks[0].layers = [video('v', 'm', at(10), at(40), 777, 777 + at(40) - at(10))]
    applyTrimLayer(p, 'v', 'In', at(1000), false) // over-trim → clamps to at(39)
    const l = p.tracks[0].layers[0]
    expect(l.t_start_us).toBe(at(39))
    expectCanonical(l.t_start_us, num, den)
    if (l.params.kind === 'VideoClip') {
      // moved by the SAME canonical delta, still not on the frame grid
      expect(l.params.src_in_us).toBe(777 + at(39) - at(10))
      expect(l.params.src_in_us).toBeLessThan(l.params.src_out_us)
    }
  })
})

describe('trim group aligned-set (live)', () => {
  it('coupled OUT trim fans out to a sibling sharing the same out-edge', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)] // same out-edge 1_000_000
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyTrimLayer(p, 'a', 'Out', 600_000, false)
    expect(p.tracks[0].layers[0].t_end_us).toBe(600_000)
    expect(p.tracks[1].layers[0].t_end_us).toBe(600_000) // sibling fanned out
  })
  it('does NOT fan out to a sibling whose edge differs', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 800_000)] // different out-edge
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyTrimLayer(p, 'a', 'Out', 600_000, false)
    expect(p.tracks[1].layers[0].t_end_us).toBe(800_000) // untouched
  })
  it('rejects a coupled trim when an aligned sibling is locked', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    p.tracks[1].layers[0].locked = true
    try { applyTrimLayer(p, 'a', 'Out', 600_000, false); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('GroupLockedMember') }
  })
})
