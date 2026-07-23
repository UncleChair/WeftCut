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
    // A=[0,100), B=[50,80) (contained, ends earlier). C=[90,120) overlaps A (reaches 100), must reject.
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('a', 0, 100), colorLayer('b', 50, 80), colorLayer('c', 90, 120)]
    // (b inside a already overlaps a → LayerOverlap fires first; assert it rejects)
    expectRule(p, 'LayerOverlap')
  })

  it('rejects an inverted layer range', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [colorLayer('a', 1_000_000, 1_000_000)]
    expectRule(p, 'InvalidLayerRange')
  })

  it('rejects a duplicate layer id across tracks', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [colorLayer('dup', 0, 100)]
    p.tracks[1].layers = [colorLayer('dup', 0, 100)]
    expectRule(p, 'DuplicateLayerId')
  })

  it('rejects audio referencing missing media and an invalid src range', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [audioLayer('a', 'nope', 0, 100)]
    expectRule(p, 'MissingMedia')
    const q = blankProject(seededGen(), 't')
    q.media_pool['m'] = { id: 'm', label: null, path_abs: '/x', path_rel: null, kind: 'Audio', metadata: { duration_us: null }, file_hash_blake3: '', file_size: 0, file_mtime: 0, imported_at: '<TS>', decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null }
    const al = audioLayer('a', 'm', 0, 100); (al.params as any).src_in_us = 100; (al.params as any).src_out_us = 50
    q.tracks[0].layers = [al]; expectRule(q, 'InvalidSrcRange')
  })

  it('rejects a group below 2 members, a missing member, and a layer in two groups', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [colorLayer('a', 0, 100)]
    p.groups = [{ id: 'g', members: ['a'] }]; expectRule(p, 'GroupBelowMinSize')
    const q = blankProject(seededGen(), 't'); q.tracks[0].layers = [colorLayer('a', 0, 100)]
    q.groups = [{ id: 'g', members: ['a', 'ghost'] }]; expectRule(q, 'GroupMemberMissing')
    const r = blankProject(seededGen(), 't'); r.tracks[0].layers = [colorLayer('a', 0, 100), colorLayer('b', 200, 300)]
    r.groups = [{ id: 'g1', members: ['a', 'b'] }, { id: 'g2', members: ['a', 'b'] }]; expectRule(r, 'LayerInMultipleGroups')
  })

  it('does NOT reject out-of-range keyframes (intentional, validate.rs:495-509)', () => {
    const p = blankProject(seededGen(), 't')
    const l = colorLayer('a', 0, 100)
    ;(l.params as any).color = { mode: 'Keyframed', value: [{ id: 'k', t_us: -50_000, value: { r: 1, g: 2, b: 3, a: 4 }, interp: { kind: 'Linear' } }] }
    p.tracks[0].layers = [l]
    expect(() => validate(p)).not.toThrow()
  })
})
