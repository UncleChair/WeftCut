// apps/desktop/src/main/state/validate.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import type { Project, Layer, LayerParams } from './model'
import { validate } from './validate'
import { isValidationFailure } from './errors'
import { timeUsAtFrame } from './snap'

function colorLayer(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 255, g: 0, b: 0, a: 255 } }, width: 1920, height: 1080 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function audioLayer(id: string, media: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Audio', media, src_in_us: 0, src_out_us: t1 - t0, gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 }, fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function expectRule(p: Project, rule: string) {
  try { validate(p); throw new Error(`expected ${rule}, but validate passed`) }
  catch (e) { if (!isValidationFailure(e)) throw e; expect(e.err.rule).toBe(rule) }
}
/** Fixture times below are all CANONICAL on the blank project's 30/1 grid
 *  (multiples of 100_000 µs = 3 frames), so a fixture never trips the grid
 *  backstop while a different rule is under test. */

describe('validate', () => {
  it('passes a blank project', () => { expect(() => validate(blankProject(seededGen(), 't'))).not.toThrow() })

  it('rejects zero canvas width/height and fps', () => {
    const p = blankProject(seededGen(), 't'); p.composition.width = 0; expectRule(p, 'InvalidCanvas')
    const q = blankProject(seededGen(), 't'); q.composition.fps = { num: 0, den: 1 }; expectRule(q, 'InvalidFps')
  })

  it('rejects two overlapping visual layers on one track', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', 0, 1_000_000), colorLayer('b', 500_000, 1_500_000)]
    expectRule(p, 'LayerOverlap')
  })

  it('allows a visual + an audio layer to coexist on one track', () => {
    const p = blankProject(seededGen(), 't')
    p.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: 2_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    p.tracks[0].layers = [colorLayer('a', 0, 1_000_000), audioLayer('b', 'm', 0, 1_000_000)]
    expect(() => validate(p)).not.toThrow()
  })

  it('rejects a transition with an Audio participant in either seat (visual-only backstop)', () => {
    const mediaItem = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio' as const, metadata: { duration_us: 10_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' as const }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    // Audio from-layer: an otherwise-valid audio↔audio transition (overlap === duration).
    const p = blankProject(seededGen(), 't')
    p.media_pool['m'] = mediaItem
    p.tracks[0].layers = [audioLayer('a', 'm', 0, 1_000_000), audioLayer('b', 'm', 800_000, 1_800_000)]
    p.transitions = [{ id: 'tr', from_layer: 'a', to_layer: 'b', duration_us: 200_000, kind: { kind: 'Crossfade' } }]
    try { validate(p); throw new Error('expected TransitionUnsupportedLayerKind, but validate passed') }
    catch (e) { if (!isValidationFailure(e)) throw e; expect(e.err).toEqual({ rule: 'TransitionUnsupportedLayerKind', transition: 'tr', layer: 'a' }) }
    // Audio to-layer behind a visual from-layer.
    const q = blankProject(seededGen(), 't')
    q.media_pool['m'] = mediaItem
    q.tracks[0].layers = [colorLayer('a', 0, 1_000_000), audioLayer('b', 'm', 800_000, 1_800_000)]
    q.transitions = [{ id: 'tr', from_layer: 'a', to_layer: 'b', duration_us: 200_000, kind: { kind: 'Crossfade' } }]
    try { validate(q); throw new Error('expected TransitionUnsupportedLayerKind, but validate passed') }
    catch (e) { if (!isValidationFailure(e)) throw e; expect(e.err).toEqual({ rule: 'TransitionUnsupportedLayerKind', transition: 'tr', layer: 'b' }) }
  })

  it('uses the longest-reaching prior layer for the next overlap check', () => {
    // A=[0,1s) with B=[0.5s,0.8s) contained in it: a plain overlap reject — the A/B
    // pair trips LayerOverlap before C=[0.9s,1.2s) is ever reached.
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', 0, 1_000_000), colorLayer('b', 500_000, 800_000), colorLayer('c', 900_000, 1_200_000)]
    expectRule(p, 'LayerOverlap')
  })

  it('rejects an inverted layer range', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [colorLayer('a', 1_000_000, 1_000_000)]
    expectRule(p, 'InvalidLayerRange')
  })

  it('rejects a duplicate layer id across tracks', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('dup', 0, 100_000)]
    p.tracks[1].layers = [colorLayer('dup', 0, 100_000)]
    expectRule(p, 'DuplicateLayerId')
  })

  it('rejects audio referencing missing media and an invalid src range', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [audioLayer('a', 'nope', 0, 100_000)]
    expectRule(p, 'MissingMedia')
    const q = blankProject(seededGen(), 't')
    q.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: null }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    const al = audioLayer('a', 'm', 0, 100_000); (al.params as any).src_in_us = 100; (al.params as any).src_out_us = 50
    q.tracks[0].layers = [al]; expectRule(q, 'InvalidSrcRange')
  })

  it('rejects a group below 2 members, a missing member, and a layer in two groups', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [colorLayer('a', 0, 100_000)]
    p.groups = [{ id: 'g', members: ['a'] }]; expectRule(p, 'GroupBelowMinSize')
    const q = blankProject(seededGen(), 't'); q.tracks[0].layers = [colorLayer('a', 0, 100_000)]
    q.groups = [{ id: 'g', members: ['a', 'ghost'] }]; expectRule(q, 'GroupMemberMissing')
    const r = blankProject(seededGen(), 't'); r.tracks[0].layers = [colorLayer('a', 0, 100_000), colorLayer('b', 200_000, 300_000)]
    r.groups = [{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['a', 'b'] }]; expectRule(r, 'LayerInMultipleGroups')
  })

  it('does NOT reject out-of-range keyframes (intentional, validate.rs:495-509)', () => {
    const p = blankProject(seededGen(), 't')
    const l = colorLayer('a', 0, 100_000)
    ;(l.params as any).color = { mode: 'Keyframed', value: [{ id: 'k', t_us: -50_000, value: { r: 1, g: 2, b: 3, a: 4 }, interp: { kind: 'Linear' } }] }
    p.tracks[0].layers = [l]
    expect(() => validate(p)).not.toThrow()
  })

  it('does NOT reject an OFF-GRID keyframe time (content-glued rebases move keys by a delta)', () => {
    // The complement of the rule below: an endpoint off the grid is rejected, a
    // keyframe off the grid is not. Re-snapping a rebased key would dedupe-merge
    // colliding keys and lose authored data — see validateLayerParams.
    const p = blankProject(seededGen(), 't')
    const l = colorLayer('a', 0, 100_000)
    ;(l.params as any).color = { mode: 'Keyframed', value: [{ id: 'k', t_us: 33_334, value: { r: 1, g: 2, b: 3, a: 4 }, interp: { kind: 'Linear' } }] }
    p.tracks[0].layers = [l]
    expect(() => validate(p)).not.toThrow()
  })
})

describe('validate — frame-grid backstop', () => {
  it('rejects an off-grid t_start_us / t_end_us with the offending field, time, rate and the value to retry with', () => {
    // 2_999_999 µs is 1 µs below frame 90 at 30/1.
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', 2_999_999, 4_000_000)]
    try { validate(p); throw new Error('expected OffGridLayerBoundary, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'a', field: 't_start_us', t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000 })
    }
    const q = blankProject(seededGen(), 't')
    q.tracks[0].layers = [colorLayer('a', 0, 2_999_999)]
    try { validate(q); throw new Error('expected OffGridLayerBoundary, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'a', field: 't_end_us', t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000 })
    }
  })

  // ── The two grids, asserted against each other ──────────────────────────────
  // Both halves in one test on purpose (ticket 10 acceptance): a predicate that
  // accepted everything for audio, or that had quietly stayed frame-only, would pass
  // one half and fail the other.
  it('holds Audio to the 48 kHz sample lattice and visual kinds to the composition frame grid', () => {
    const audioMedia = (p: Project) => {
      p.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: 10_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    }
    // 29.97, where the two lattices genuinely differ: frame 1 is 33_367 µs and
    // sample 1602 is 33_375 µs, so each grid rejects the other's boundary.
    const FPS = { num: 30000, den: 1001 }
    const FRAME_1 = 33_367
    const SAMPLE_1602 = 33_375

    // Audio ACCEPTS a sample boundary the frame grid would reject...
    const ok = blankProject(seededGen(), 't')
    ok.composition.fps = FPS
    ok.composition.duration_us = timeUsAtFrame(2, FPS.num, FPS.den) // encloses the tail
    audioMedia(ok)
    ok.tracks[0].layers = [audioLayer('a', 'm', 0, SAMPLE_1602)]
    expect(() => validate(ok)).not.toThrow()

    // ...and REJECTS a frame boundary that is not a sample boundary, with the
    // lattice it was measured against named in the error.
    const bad = blankProject(seededGen(), 't')
    bad.composition.fps = FPS
    bad.composition.duration_us = timeUsAtFrame(2, FPS.num, FPS.den)
    audioMedia(bad)
    bad.tracks[0].layers = [audioLayer('a', 'm', 0, FRAME_1)]
    try { validate(bad); throw new Error('expected OffGridLayerBoundary for frame-aligned audio at 29.97') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      // `snap_to` is the OTHER constant: the two lattices are 8 µs apart here, so the
      // repair the caller is told to make lands exactly on sample 1602.
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'a', field: 't_end_us', t: FRAME_1, fps: { num: 48_000, den: 1 }, grid: 'sample', snap_to: SAMPLE_1602 })
    }

    // A VISUAL layer is the mirror image: the frame boundary passes, the sample
    // boundary does not. This is the assertion that fails if the predicate ever
    // collapses back to one grid for both kinds.
    const vis = blankProject(seededGen(), 't')
    vis.composition.fps = FPS
    vis.composition.duration_us = timeUsAtFrame(2, FPS.num, FPS.den)
    vis.tracks[0].layers = [colorLayer('v', 0, FRAME_1)]
    expect(() => validate(vis)).not.toThrow()
    const visBad = blankProject(seededGen(), 't')
    visBad.composition.fps = FPS
    visBad.composition.duration_us = timeUsAtFrame(2, FPS.num, FPS.den)
    visBad.tracks[0].layers = [colorLayer('v', 0, SAMPLE_1602)]
    try { validate(visBad); throw new Error('expected OffGridLayerBoundary for sample-aligned video at 29.97') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      // ...and symmetrically back: the visual repair lands on frame 1.
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'v', field: 't_end_us', t: SAMPLE_1602, fps: FPS, grid: 'frame', snap_to: FRAME_1 })
    }
  })

  it('does not flag two audio layers whose edges differ by one sample as overlapping', () => {
    // The half-open `[t_start, t_end)` comparison gives this for free at 20.83 µs
    // precision — the regression exists so nobody "fixes" it with a tolerance.
    const p = blankProject(seededGen(), 't')
    p.composition.fps = { num: 30000, den: 1001 }
    p.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: 10_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    const s = (i: number) => timeUsAtFrame(i, 48_000, 1)
    p.composition.duration_us = timeUsAtFrame(1, 30000, 1001)
    // Abutting at sample 480, then one more layer starting exactly one sample later.
    p.tracks[0].layers = [audioLayer('a', 'm', s(0), s(480)), audioLayer('b', 'm', s(480), s(960))]
    expect(() => validate(p)).not.toThrow()
    // And a one-sample genuine overlap IS still caught.
    const q = blankProject(seededGen(), 't')
    q.composition.fps = { num: 30000, den: 1001 }
    q.media_pool['m'] = p.media_pool['m']
    q.composition.duration_us = timeUsAtFrame(1, 30000, 1001)
    q.tracks[0].layers = [audioLayer('a', 'm', s(0), s(481)), audioLayer('b', 'm', s(480), s(960))]
    expectRule(q, 'LayerOverlap')
  })

  it('accepts canonical endpoints at a fractional rate and rejects the neighbouring µs', () => {
    // At 30000/1001 frame 1 is 33_367 µs, not 33_366 — the divergence that makes a
    // hand-computed grid wrong.
    const p = blankProject(seededGen(), 't')
    p.composition.fps = { num: 30000, den: 1001 }
    p.composition.duration_us = 33_367
    p.tracks[0].layers = [colorLayer('a', 0, 33_367)]
    expect(() => validate(p)).not.toThrow()
    const q = blankProject(seededGen(), 't')
    q.composition.fps = { num: 30000, den: 1001 }
    q.composition.duration_us = 33_366
    q.tracks[0].layers = [colorLayer('a', 0, 33_366)]
    expectRule(q, 'OffGridTime') // composition duration is checked first
  })

  it('rejects a negative t_start_us as a BOUNDS failure, not an off-grid one', () => {
    // -1_000_000 is frame -30 at 30/1 — perfectly canonical, so the grid predicate
    // waves it through. This is the rule that catches it, and reporting it as
    // "off grid" instead would point the caller at the wrong fix.
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', -1_000_000, 1_000_000)]
    try { validate(p); throw new Error('expected NegativeLayerStart, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'NegativeLayerStart', layer: 'a', t_start: -1_000_000 })
    }
    // A layer starting exactly at 0 is fine — the bound is inclusive.
    const q = blankProject(seededGen(), 't')
    q.tracks[0].layers = [colorLayer('a', 0, 1_000_000)]
    expect(() => validate(q)).not.toThrow()
  })

  it('rejects an off-grid composition.duration_us', () => {
    const p = blankProject(seededGen(), 't')
    p.composition.duration_us = 2_999_999
    try { validate(p); throw new Error('expected OffGridTime, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridTime', entity: 'Composition', id: null, field: 'duration_us', t: 2_999_999, fps: { num: 30, den: 1 }, snap_to: 3_000_000 })
    }
  })

  it('rejects an off-grid marker t_us / end_t_us', () => {
    const p = blankProject(seededGen(), 't')
    p.markers = [{ id: 'mk', t_us: 2_999_999, end_t_us: null, label: 'm', color: { r: 0, g: 0, b: 0, a: 255 }, metadata: {} }]
    try { validate(p); throw new Error('expected OffGridTime, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridTime', entity: 'Marker', id: 'mk', field: 't_us', t: 2_999_999, fps: { num: 30, den: 1 }, snap_to: 3_000_000 })
    }
    const q = blankProject(seededGen(), 't')
    q.markers = [{ id: 'mk', t_us: 0, end_t_us: 2_999_999, label: 'm', color: { r: 0, g: 0, b: 0, a: 255 }, metadata: {} }]
    expectRule(q, 'OffGridTime')
  })

  it('does NOT require transition.duration_us to be a canonical time (it is a distance)', () => {
    // At 30000/1001 a 1-frame transition at cut frame 1 is 33_366 µs — off the
    // grid as an absolute time, exactly right as a distance. Both endpoints are
    // canonical and overlap === duration_us, so validate must accept it.
    const p = blankProject(seededGen(), 't')
    p.composition.fps = { num: 30000, den: 1001 }
    const cut = 33_367            // frame 1
    const fromEnd = 66_733        // frame 2
    p.composition.duration_us = 100_100 // frame 3
    p.tracks[0].layers = [colorLayer('a', 0, fromEnd), colorLayer('b', cut, 100_100)]
    p.transitions = [{ id: 'tr', from_layer: 'a', to_layer: 'b', duration_us: fromEnd - cut, kind: { kind: 'Crossfade' } }]
    expect(fromEnd - cut).toBe(33_366) // NOT a canonical time
    expect(() => validate(p)).not.toThrow()
  })

  it('reports every endpoint as on-grid under a degenerate rate (InvalidFps owns that project)', () => {
    const p = blankProject(seededGen(), 't')
    p.composition.fps = { num: 0, den: 1 }
    p.tracks[0].layers = [colorLayer('a', 2_999_999, 4_000_001)]
    expectRule(p, 'InvalidFps')
  })
})
