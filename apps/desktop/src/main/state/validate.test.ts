// apps/desktop/src/main/state/validate.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import type { Project, Layer, LayerParams } from './model'
import { validate } from './validate'
import { isValidationFailure } from './errors'

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
    // A=[0,1s), B=[0.5s,0.8s) (contained, ends earlier). C=[0.9s,1.2s) overlaps A (reaches 1s), must reject.
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', 0, 1_000_000), colorLayer('b', 500_000, 800_000), colorLayer('c', 900_000, 1_200_000)]
    // (b inside a already overlaps a → LayerOverlap fires first; assert it rejects)
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
  it('rejects an off-grid t_start_us / t_end_us with the offending field, time and rate', () => {
    // 2_999_999 µs is 1 µs below frame 90 at 30/1 — the exact shape the trim
    // source-duration clamp used to persist.
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', 2_999_999, 4_000_000)]
    try { validate(p); throw new Error('expected OffGridLayerBoundary, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'a', field: 't_start_us', t: 2_999_999, fps: { num: 30, den: 1 } })
    }
    const q = blankProject(seededGen(), 't')
    q.tracks[0].layers = [colorLayer('a', 0, 2_999_999)]
    try { validate(q); throw new Error('expected OffGridLayerBoundary, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridLayerBoundary', layer: 'a', field: 't_end_us', t: 2_999_999, fps: { num: 30, den: 1 } })
    }
  })

  it('checks Audio layers against the composition grid too (kind-aware predicate, one grid today)', () => {
    const p = blankProject(seededGen(), 't')
    p.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: 10_000_000 }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    p.tracks[0].layers = [audioLayer('a', 'm', 0, 2_999_999)]
    expectRule(p, 'OffGridLayerBoundary')
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

  it('rejects an off-grid composition.duration_us', () => {
    const p = blankProject(seededGen(), 't')
    p.composition.duration_us = 2_999_999
    try { validate(p); throw new Error('expected OffGridTime, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridTime', entity: 'Composition', id: null, field: 'duration_us', t: 2_999_999, fps: { num: 30, den: 1 } })
    }
  })

  it('rejects an off-grid marker t_us / end_t_us', () => {
    const p = blankProject(seededGen(), 't')
    p.markers = [{ id: 'mk', t_us: 2_999_999, end_t_us: null, label: 'm', color: { r: 0, g: 0, b: 0, a: 255 }, metadata: {} }]
    try { validate(p); throw new Error('expected OffGridTime, but validate passed') }
    catch (e) {
      if (!isValidationFailure(e)) throw e
      expect(e.err).toEqual({ rule: 'OffGridTime', entity: 'Marker', id: 'mk', field: 't_us', t: 2_999_999, fps: { num: 30, den: 1 } })
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
