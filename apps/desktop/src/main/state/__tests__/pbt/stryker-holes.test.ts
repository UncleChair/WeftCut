// apps/desktop/src/main/state/__tests__/pbt/stryker-holes.test.ts
//
// Example tests targeting specific Stryker-surviving mutants; each describe block
// covers one code region.
//
// Approach: minimal, fast, deterministic example tests — no fc.assert overhead.
import { describe, it, expect } from 'vitest'
import { seededGen } from '../../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../../model'
import { validate } from '../../validate'
import { applyAddLayer, colorParams } from '../../mutations/add'
import { applyMoveLayer } from '../../mutations/move'
import { applyTrimLayer, clampSigned, trimDeltaBounds } from '../../mutations/trim'
import { applyGroupsCreate } from '../../mutations/groups'
import { ValidationFailure, isCommandFailure } from '../../errors'

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkProject(): Project { return blankProject(seededGen(), 't') }

function audioLayer(id: string, t0: number, t1: number, srcIn = 0, srcOut = t1 - t0): Layer {
  const params: LayerParams = {
    kind: 'Audio', media: 'media-1', src_in_us: srcIn, src_out_us: srcOut,
    gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
    fade_in_us: 0, fade_out_us: 0, mute: false, role: 'dialogue',
  }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function videoClipLayer(id: string, t0: number, t1: number, srcIn = 0, srcOut = t1 - t0): Layer {
  const s = (v: number) => ({ mode: 'Static' as const, value: v })
  const params: LayerParams = {
    kind: 'VideoClip', media: 'media-1', src_in_us: srcIn, src_out_us: srcOut,
    transform: { x: s(0), y: s(0), scale_x: s(1), scale_y: s(1), rotation_deg: s(0), anchor_x: { mode: 'Static', value: 0.5 }, anchor_y: { mode: 'Static', value: 0.5 }, scale_linked: true },
    opacity: s(1), crop: null, flip_h: false, flip_v: false, blend_mode: 'Normal', speed: 1,
    fade_in_us: 0, fade_out_us: 0,
  }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function colorLayer(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

// Minimal valid project with a real MediaItem for video/audio source checks.
function projectWithMedia(): Project {
  const p = mkProject()
  p.media_pool['media-1'] = {
    id: 'media-1', label: null, path_abs: '/f.mp4', path_rel: null, kind: 'Video',
    metadata: { duration_us: 10_000_000 }, file_hash_blake3: 'abc', file_size: 0, file_mtime: 0,
    imported_at: new Date().toISOString(), decode_route: { route: 'bypass' },
    conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
  return p
}

// ── validate.ts: layerOverlapClass ───────────────────────────────────────────
// Mutant: 'Audio' ? "" : 'visual' — audio treated as visual; overlap not caught.
describe('validate: layerOverlapClass distinguishes audio from visual', () => {
  it('two audio layers that overlap on the same track fail validation', () => {
    const p = projectWithMedia()
    p.tracks[0].layers = [
      audioLayer('a1', 0, 1_000_000),
      audioLayer('a2', 500_000, 1_500_000),
    ]
    p.composition.duration_us = 1_500_000
    // If audio is classified as visual (mutant), the overlap is checked in the
    // visual lane; if as audio (correct), it's checked in the audio lane.
    // Either way an unauthorized overlap must be rejected.
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('audio and visual layers can overlap freely (different lanes)', () => {
    const p = projectWithMedia()
    p.tracks[0].layers = [
      colorLayer('v1', 0, 1_000_000),
      audioLayer('a1', 500_000, 1_500_000),
    ]
    p.composition.duration_us = 1_500_000
    expect(() => validate(p)).not.toThrow()
  })
})

// ── validate.ts: srcIn < 0 check ─────────────────────────────────────────────
// Mutant: 'srcIn < 0 || srcIn >= srcOut' → 'false || srcIn >= srcOut' — drops negative-srcIn check.
describe('validate: checkSrcRange negative srcIn', () => {
  it('rejects a VideoClip with srcIn < 0', () => {
    const p = projectWithMedia()
    p.tracks[0].layers = [videoClipLayer('v1', 0, 1_000_000, -1, 1_000_000)]
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('rejects an Audio layer with srcIn < 0', () => {
    const p = projectWithMedia()
    p.tracks[0].layers = [audioLayer('a1', 0, 1_000_000, -100, 1_000_000)]
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
})

// ── validate.ts: dur !== null guard ─────────────────────────────────────────
// Mutants: 'true && srcOut > dur' / 'true && dur !== undefined' — drops null guard.
describe('validate: srcOut vs media duration allows null duration', () => {
  it('accepts a VideoClip whose media has null duration (streaming/live)', () => {
    const p = mkProject()
    p.media_pool['media-1'] = {
      id: 'media-1', label: null, path_abs: '/f.mp4', path_rel: null, kind: 'Video',
      metadata: { duration_us: null }, file_hash_blake3: 'abc', file_size: 0, file_mtime: 0,
      imported_at: new Date().toISOString(), decode_route: { route: 'bypass' },
      conform_path: null, waveform_path: null, thumbnails_dir: null,
    }
    p.tracks[0].layers = [videoClipLayer('v1', 0, 5_000_000, 0, 5_000_000)]
    p.composition.duration_us = 5_000_000
    expect(() => validate(p)).not.toThrow()
  })

  it('rejects a VideoClip whose srcOut exceeds a finite media duration', () => {
    const p = projectWithMedia() // media-1 has duration 10s
    p.tracks[0].layers = [videoClipLayer('v1', 0, 1_000_000, 0, 11_000_000)]
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
})

// ── validate.ts: stacked unauthorized overlaps on one lane ───────────────────
// Any unauthorized same-lane overlap throws on first contact, so validateTrack's
// longest-reaching `prevVisual` update is unreachable from a clean fixture.
describe('validate: stacked unauthorized overlaps on one lane', () => {
  it('rejects a track with multiple unauthorized same-lane overlaps', () => {
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('long', 0, 2_000_000),
      colorLayer('short', 0, 500_000),   // same start, ends earlier
      colorLayer('late', 400_000, 1_200_000),
    ]
    p.composition.duration_us = 2_000_000
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
})

// ── validate.ts: pairKey lookup (authorized overlap) ─────────────────────────
// pairKey is used symmetrically (the same comparator builds the stored key and
// the lookup key), so comparator flips cancel; the empty-key mutant is covered by
// the "non-empty canonical key" test below.
describe('validate: pairKey lookup (authorized overlap)', () => {
  it('accepts an authorized overlap regardless of from/to ID ordering', () => {
    // Use IDs where 'id-b' < 'id-a' lexicographically, so the authorized pair
    // is stored from the (from,to) order but the per-track check sees (prev,layer)
    // in t_start order. Both go through the same pairKey, so they agree.
    const p = mkProject()
    // Ensure 'id-b' < 'id-a' lexicographically.
    const fromId = 'id-b-from'
    const toId   = 'id-a-to'   // 'id-a' < 'id-b' → pairKey should produce 'id-a-to|id-b-from'
    p.tracks[0].layers = [
      colorLayer(fromId, 0, 1_000_000),
      colorLayer(toId, 800_000, 1_800_000),  // 200µs overlap
    ]
    p.transitions.push({ id: 'tr1', from_layer: fromId, to_layer: toId, duration_us: 200_000, kind: { kind: 'Crossfade' } })
    p.composition.duration_us = 1_800_000
    // Should be accepted — the authorized overlap exactly matches.
    expect(() => validate(p)).not.toThrow()
  })
})

// ── trimDeltaBounds: VideoClip src constraints ────────────────────────────────
// Mutants: srcMin and srcMax for VideoClip/Audio miscomputed; kind check dropped.
describe('trimDeltaBounds: VideoClip/Audio src-bound constraints', () => {
  it('In edge: srcMax = src_out - src_in - 1 (max shift that keeps 1µs of src)', () => {
    const layer = videoClipLayer('v1', 1_000_000, 3_000_000, 500_000, 2_500_000)
    // src_in=500_000, src_out=2_500_000 → srcMax = 2_500_000 - 500_000 - 1 = 1_999_999
    const b = trimDeltaBounds(layer, 'In', null)
    expect(b.max).toBe(1_999_999)
  })

  it('In edge: srcMin = -src_in (max leftward shift that keeps src_in ≥ 0)', () => {
    const layer = videoClipLayer('v1', 1_000_000, 3_000_000, 500_000, 2_500_000)
    // srcMin = -500_000; timelineMin = -1_000_000 → max(-1_000_000, -500_000) = -500_000
    const b = trimDeltaBounds(layer, 'In', null)
    expect(b.min).toBe(-500_000)
  })

  it('Out edge: srcMin = -(src_out - src_in - 1)', () => {
    const layer = videoClipLayer('v1', 0, 2_000_000, 0, 2_000_000)
    // srcMin = -(2_000_000 - 0 - 1) = -1_999_999; timelineMin = -(2_000_000 - 1) = -1_999_999
    const b = trimDeltaBounds(layer, 'Out', null)
    expect(b.min).toBe(-1_999_999)
  })

  it('Color layer has no src bounds — In srcMin is only timeline-clamped', () => {
    const layer = colorLayer('c1', 1_000_000, 3_000_000)
    // timelineMin = -1_000_000; no src constraint → min = -1_000_000
    const b = trimDeltaBounds(layer, 'In', null)
    expect(b.min).toBe(-1_000_000)
  })

  it('applies VideoClip src trim correctly through applyTrimLayer', () => {
    const p = projectWithMedia()
    p.media_pool['media-1'].metadata.duration_us = 10_000_000
    // Layer at [0, 2s], src_in=0, src_out=2s.
    p.tracks[0].layers = [videoClipLayer('v1', 0, 2_000_000, 0, 2_000_000)]
    // Trim In to 500_000: delta = +500_000; src_in shifts by +500_000 → 500_000.
    applyTrimLayer(p, 'v1', 'In', 500_000, false)
    const l = p.tracks[0].layers.find((x) => x.id === 'v1')!
    expect(l.t_start_us).toBe(500_000)
    // src_in should advance by the same delta (glued to content).
    const pa = l.params as { kind: 'VideoClip'; src_in_us: number; src_out_us: number }
    expect(pa.src_in_us).toBe(500_000)
    expect(pa.src_out_us).toBe(2_000_000) // unchanged (Out was not trimmed)
  })

  it('trim Out on VideoClip adjusts src_out correctly', () => {
    const p = projectWithMedia()
    p.media_pool['media-1'].metadata.duration_us = 10_000_000
    p.tracks[0].layers = [videoClipLayer('v1', 0, 3_000_000, 0, 3_000_000)]
    applyTrimLayer(p, 'v1', 'Out', 2_000_000, false)
    const l = p.tracks[0].layers.find((x) => x.id === 'v1')!
    const pa = l.params as { kind: 'VideoClip'; src_in_us: number; src_out_us: number }
    expect(pa.src_out_us).toBe(2_000_000)
    expect(pa.src_in_us).toBe(0) // unchanged
  })
})

// ── clampSigned: min > max boundary ─────────────────────────────────────────
// Mutant: min > max → min >= max — would collapse equal min/max when it's valid.
describe('clampSigned boundary min === max', () => {
  it('does NOT collapse when min === max — returns the single valid value', () => {
    // min === max = 5: only valid value is 5.
    expect(clampSigned(10, 5, 5)).toBe(5)
    expect(clampSigned(0, 5, 5)).toBe(5)
    expect(clampSigned(-10, 5, 5)).toBe(5)
  })

  it('collapses (returns 0) only when min > max (inverted bounds)', () => {
    expect(clampSigned(50, 10, -10)).toBe(0)
    expect(clampSigned(-50, 10, -10)).toBe(0)
  })
})

// ── applyMoveLayer: insertion order (findIndex + splice) ────────────────────
// Mutants: 'l.t_start_us > snapped' → true/false/>=/<= — layer placed at wrong position.
describe('applyMoveLayer: layers stay t_start_us sorted after a move', () => {
  it('inserts the moved layer in the correct sorted position among existing layers', () => {
    const p = mkProject()
    // Add three non-overlapping color layers (no group, no validate issues).
    const g = seededGen()
    applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 200_000)
    applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 400_000, 600_000)
    const c = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 800_000, 1_000_000)

    // Move 'c' to 300_000 so it should land between the first two.
    applyMoveLayer(p, c, p.tracks[0].id, 300_000, false)
    // After move the move itself doesn't validate; check the sort order.
    const starts = p.tracks[0].layers.map((l) => l.t_start_us)
    // starts should be non-decreasing after the move.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1])
    }
  })

  it('layer moved to position 0 appears first, not last', () => {
    const p = mkProject()
    const g = seededGen()
    applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 500_000, 700_000)
    const id = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 800_000, 1_000_000)
    // Move 'id' to t=0, ahead of the existing layer at 500_000.
    applyMoveLayer(p, id, p.tracks[0].id, 0, false)
    expect(p.tracks[0].layers[0].id).toBe(id)
    expect(p.tracks[0].layers[0].t_start_us).toBe(0)
  })
})

// ── applyMoveLayer: delta !== 0 guard for group siblings ────────────────────
// Mutant: 'if (delta !== 0)' → 'if (true)' — would shift siblings even on zero delta.
// Group-sibling follow shifts time only; cross-track moves apply the track change
// to the primary layer and leave siblings on their original tracks.
describe('applyMoveLayer: zero-delta group sibling move is a no-op shift', () => {
  it('sibling t_start is unchanged when delta is zero (same position)', () => {
    const p = mkProject()
    // Place both layers on track 0; group them.
    p.tracks[0].layers = [colorLayer('a', 0, 200_000), colorLayer('b', 400_000, 600_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    // Move 'a' to its current position → delta = 0.
    // Sibling 'b' should stay at 400_000 (no shift applied).
    applyMoveLayer(p, 'a', p.tracks[0].id, 0, false)
    const bAfter = p.tracks[0].layers.find((l) => l.id === 'b')!.t_start_us
    expect(bAfter).toBe(400_000)
  })

  it('sibling correctly shifts by the same delta when delta is non-zero', () => {
    const p = mkProject()
    // Both layers on track 0; 'a' at 0 and 'b' at 500_000 (non-overlapping).
    p.tracks[0].layers = [colorLayer('a', 0, 200_000), colorLayer('b', 500_000, 700_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    // Move 'a' from 0 to 300_000 → delta = 300_000.
    applyMoveLayer(p, 'a', p.tracks[0].id, 300_000, false)
    // Sibling 'b' follows: 500_000 + 300_000 = 800_000.
    const bAfter = p.tracks[0].layers.find((l) => l.id === 'b')!.t_start_us
    expect(bAfter).toBe(800_000)
  })
})

// ── applyTrimLayer: re-sort after In trim ───────────────────────────────────
// Mutants on applyTrimLayer's re-sort block and its comparator.
describe('applyTrimLayer: track re-sorted after In trim changes start', () => {
  it('layers remain sorted by t_start_us after In-trim moves a layer earlier', () => {
    const p = mkProject()
    // Two layers: a [300_000, 600_000), b [700_000, 1_000_000).
    // Trim b's In edge to 500_000 → b now starts at 500_000 — still after a.
    // But if we trim b to 200_000 → b starts before a. Re-sort must restore order.
    p.tracks[0].layers = [
      colorLayer('a', 300_000, 600_000),
      colorLayer('b', 700_000, 1_000_000),
    ]
    applyTrimLayer(p, 'b', 'In', 200_000, false)
    const starts = p.tracks[0].layers.map((l) => l.t_start_us)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1])
    }
  })

  it('Out trim does NOT re-sort (t_start unchanged)', () => {
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('a', 0, 500_000),
      colorLayer('b', 600_000, 1_000_000),
    ]
    const aIdxBefore = p.tracks[0].layers.findIndex((l) => l.id === 'a')
    applyTrimLayer(p, 'a', 'Out', 300_000, false)
    const aIdxAfter = p.tracks[0].layers.findIndex((l) => l.id === 'a')
    // 'a' stays in position 0 (Out trim never changes t_start, so no re-sort needed).
    expect(aIdxAfter).toBe(aIdxBefore)
  })
})

// ── validate.ts: transition duration checks ─────────────────────────────────
// Mutants in transitionInvariantError: tr.duration_us <= 0 variants; fromLen/toLen boundaries.
describe('validate: transition duration boundary checks', () => {
  it('rejects a transition with duration_us === 0', () => {
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('l1', 0, 1_000_000),
      colorLayer('l2', 1_000_000, 2_000_000),  // adjacent, no overlap
    ]
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l2', duration_us: 0, kind: { kind: 'Crossfade' } })
    p.composition.duration_us = 2_000_000
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('rejects a transition whose duration exactly equals layer length', () => {
    // duration_us > fromLen is required; duration === fromLen should fail.
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('l1', 0, 500_000),   // len=500_000
      colorLayer('l2', 300_000, 800_000), // overlap=200_000 < len
    ]
    // duration_us = 500_000 = fromLen → must be rejected (> fromLen fails).
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l2', duration_us: 500_000, kind: { kind: 'Crossfade' } })
    p.composition.duration_us = 800_000
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('accepts a valid transition whose duration matches the overlap and is < layer lengths', () => {
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('l1', 0, 1_000_000),
      colorLayer('l2', 800_000, 1_800_000), // overlap = 200_000
    ]
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l2', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    p.composition.duration_us = 1_800_000
    expect(() => validate(p)).not.toThrow()
  })
})

// ── trimDeltaBounds: Audio kind — separate arm from VideoClip ────────────────
// Mutants on trimDeltaBounds' In/Out arms: 'pa.kind === "Audio"' → '' or removed — Audio
// kind not constrained. The VideoClip tests above cover the VideoClip half;
// these cover the Audio half (same expression, different discriminant).
describe('trimDeltaBounds: Audio layer src-bound constraints', () => {
  it('Audio In edge: srcMax = src_out - src_in - 1', () => {
    const layer = audioLayer('a1', 1_000_000, 3_000_000, 200_000, 2_200_000)
    // src_in=200_000, src_out=2_200_000 → srcMax = 2_200_000 - 200_000 - 1 = 1_999_999
    const b = trimDeltaBounds(layer, 'In', null)
    expect(b.max).toBe(1_999_999)
  })

  it('Audio In edge: srcMin = -src_in', () => {
    const layer = audioLayer('a1', 1_000_000, 3_000_000, 300_000, 2_300_000)
    // srcMin = -300_000; timelineMin = -1_000_000 → max = -300_000
    const b = trimDeltaBounds(layer, 'In', null)
    expect(b.min).toBe(-300_000)
  })

  it('Audio Out edge: srcMin = -(src_out - src_in - 1)', () => {
    const layer = audioLayer('a1', 0, 2_000_000, 0, 2_000_000)
    // srcMin = -(2_000_000 - 0 - 1) = -1_999_999
    const b = trimDeltaBounds(layer, 'Out', null)
    expect(b.min).toBe(-1_999_999)
  })

  it('applies Audio src trim correctly through applyTrimLayer', () => {
    const p = projectWithMedia()
    p.media_pool['media-1'].metadata.duration_us = 10_000_000
    p.tracks[0].layers = [audioLayer('a1', 0, 3_000_000, 0, 3_000_000)]
    // Trim In to 500_000: delta = +500_000 → src_in shifts too.
    applyTrimLayer(p, 'a1', 'In', 500_000, false)
    const l = p.tracks[0].layers.find((x) => x.id === 'a1')!
    const pa = l.params as { kind: 'Audio'; src_in_us: number; src_out_us: number }
    expect(pa.src_in_us).toBe(500_000)
    expect(pa.src_out_us).toBe(3_000_000)
  })

  it('trim Out on Audio adjusts src_out correctly', () => {
    const p = projectWithMedia()
    p.media_pool['media-1'].metadata.duration_us = 10_000_000
    p.tracks[0].layers = [audioLayer('a1', 0, 3_000_000, 0, 3_000_000)]
    applyTrimLayer(p, 'a1', 'Out', 2_000_000, false)
    const l = p.tracks[0].layers.find((x) => x.id === 'a1')!
    const pa = l.params as { kind: 'Audio'; src_in_us: number; src_out_us: number }
    expect(pa.src_out_us).toBe(2_000_000)
    expect(pa.src_in_us).toBe(0)
  })
})

// ── applyMoveLayer: locked destination track check ──────────────────────────
// Mutants on applyMoveLayer's cross-track lock check for dst.
describe('applyMoveLayer: locked destination track', () => {
  it('rejects a cross-track move when the destination track is locked', () => {
    const p = mkProject()
    const g = seededGen()
    const id = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 500_000)
    p.tracks[1].locked = true
    try {
      applyMoveLayer(p, id, p.tracks[1].id, 0, false)
      throw new Error('expected throw')
    } catch (e: unknown) {
      expect(isCommandFailure(e) && (e as { err: { error: string } }).err.error).toBe('TrackLocked')
    }
  })
})

// ── applyMoveLayer: sibling insertion sort (group fanout) ───────────────────
// Mutants on applyMoveLayer's group-sibling re-insertion: position sorted wrong.
describe('applyMoveLayer: group sibling insertion position', () => {
  it('group sibling is reinserted in sorted order after following the delta', () => {
    const p = mkProject()
    // Three layers on track 0: a[0,200), b[400,600) grouped, c[800,1000).
    // Move 'a' to 600_000 → delta=600_000; sibling 'b' follows to 1_000_000.
    p.tracks[0].layers = [
      colorLayer('a', 0, 200_000),
      colorLayer('b', 400_000, 600_000),
      colorLayer('c', 800_000, 1_000_000),
    ]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    // After move: a[600k,800k), b[1000k,1200k), c[800k,1000k) — check sort order.
    applyMoveLayer(p, 'a', p.tracks[0].id, 600_000, false)
    const starts = p.tracks[0].layers.map((l) => l.t_start_us)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1])
    }
  })
})

// ── validate.ts: validateComposition — canvas and fps checks ─────────────────
// Mutants: 'c.width === 0 || c.height === 0' drops one arm; fps arms similar.
describe('validate: validateComposition', () => {
  it('rejects zero width', () => {
    const p = mkProject(); p.composition.width = 0
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
  it('rejects zero height', () => {
    const p = mkProject(); p.composition.height = 0
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
  it('rejects zero fps.num', () => {
    const p = mkProject(); p.composition.fps.num = 0
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
  it('rejects zero fps.den', () => {
    const p = mkProject(); p.composition.fps.den = 0
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
})

// ── validate.ts: transition structural rules ─────────────────────────────────
// Mutants: seenIds.has, tr.from_layer===tr.to_layer, from.track!==to.track guards.
describe('validate: transition structural integrity', () => {
  it('rejects a duplicate transition id', () => {
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('l1', 0, 1_000_000),
      colorLayer('l2', 800_000, 1_800_000),
    ]
    p.composition.duration_us = 1_800_000
    // Add the same transition twice — second has a duplicate tr.id.
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l2', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l2', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('rejects a self-referencing transition (from_layer === to_layer)', () => {
    const p = mkProject()
    p.tracks[0].layers = [colorLayer('l1', 0, 1_000_000)]
    p.composition.duration_us = 1_000_000
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l1', duration_us: 100_000, kind: { kind: 'Crossfade' } })
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('rejects a cross-track transition', () => {
    const p = mkProject()
    p.tracks[0].layers = [colorLayer('l1', 0, 1_000_000)]
    p.tracks[1].layers = [colorLayer('l2', 800_000, 1_800_000)]
    p.composition.duration_us = 1_800_000
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l2', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('rejects a layer used as from_layer in two transitions', () => {
    const p = mkProject()
    // l1 → l2 and l1 → l3: l1 appears as from_layer twice.
    p.tracks[0].layers = [
      colorLayer('l1', 0, 1_000_000),
      colorLayer('l2', 800_000, 1_800_000),
      colorLayer('l3', 900_000, 1_900_000),
    ]
    p.composition.duration_us = 1_900_000
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l2', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    p.transitions.push({ id: 'tr2', from_layer: 'l1', to_layer: 'l3', duration_us: 100_000, kind: { kind: 'Crossfade' } })
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('rejects a layer used as to_layer in two transitions', () => {
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('l1', 0, 1_000_000),
      colorLayer('l2', 0, 1_000_000),
      colorLayer('l3', 800_000, 1_800_000),
    ]
    p.composition.duration_us = 1_800_000
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l3', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    p.transitions.push({ id: 'tr2', from_layer: 'l2', to_layer: 'l3', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    expect(() => validate(p)).toThrow(ValidationFailure)
  })

  it('fromLen computed as end-start (not start-end) — catches arithmetic mutation', () => {
    // A transition with duration_us > fromLen should fail.
    // fromLen = l1.end - l1.start = 300_000. If mutated to start-end → negative → duration always OK.
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('l1', 0, 300_000),        // fromLen = 300_000
      colorLayer('l2', 200_000, 700_000),  // overlap = 100_000, toLen = 500_000
    ]
    p.composition.duration_us = 700_000
    // duration_us = 400_000 > fromLen=300_000 → must be rejected.
    p.transitions.push({ id: 'tr1', from_layer: 'l1', to_layer: 'l2', duration_us: 400_000, kind: { kind: 'Crossfade' } })
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
})

// ── validate.ts: srcIn >= srcOut boundary ───────────────────────────────────
// Mutant: 'srcIn >= srcOut' → 'srcIn > srcOut' — allows srcIn === srcOut (zero src).
describe('validate: srcIn === srcOut (zero-length source range)', () => {
  it('rejects srcIn === srcOut (empty source range)', () => {
    const p = projectWithMedia()
    // srcIn = srcOut = 0 → empty range; should fail InvalidSrcRange.
    p.tracks[0].layers = [videoClipLayer('v1', 0, 1_000_000, 500_000, 500_000)]
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
})

// ── validate.ts: ImageOverlay missing media check ────────────────────────────
// Mutants: 'else if (pa.kind === "ImageOverlay")' branch and the fail inside.
describe('validate: ImageOverlay missing media', () => {
  it('rejects an ImageOverlay that references a missing media id', () => {
    const p = mkProject()
    const s = (v: number) => ({ mode: 'Static' as const, value: v })
    const params: LayerParams = {
      kind: 'ImageOverlay', media: 'missing-media-id',
      transform: { x: s(0), y: s(0), scale_x: s(1), scale_y: s(1), rotation_deg: s(0), anchor_x: { mode: 'Static', value: 0.5 }, anchor_y: { mode: 'Static', value: 0.5 }, scale_linked: true },
      opacity: s(1), blend_mode: 'Normal', fade_in_us: 0, fade_out_us: 0,
    }
    const layer: Layer = { id: 'img1', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {}, params, effects: [] }
    p.tracks[0].layers = [layer]
    p.composition.duration_us = 1_000_000
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
})

// ── validate.ts: overlap detection is storage-order-independent ──────────────
// Overlap is caught in either storage order; validateTrack's layer sort only
// matters for >2 layers, so the sort-removal mutant survives here.
describe('validate: overlap detection is storage-order-independent', () => {
  it('detects an unauthorized overlap regardless of layer storage order', () => {
    const p = mkProject()
    // Store layers in reverse t_start order: l2 first, then l1.
    p.tracks[0].layers = [
      colorLayer('l2', 600_000, 1_400_000),
      colorLayer('l1', 0, 800_000),
    ]
    p.composition.duration_us = 1_400_000
    expect(() => validate(p)).toThrow(ValidationFailure)
  })
})

// ── validate.ts: pairKey — empty string mutation (template literal) ───────────
// Mutants: template literal ${a}|${b} → '' — key always empty, lookup always fails.
describe('validate: pairKey produces a non-empty canonical key', () => {
  it('transition overlap is authorized only if the exact key matches (non-empty)', () => {
    // The pairKey empty-string mutant would store '' in authorized → the lookup for
    // any pair would also produce '' → incorrectly authorize ALL overlaps.
    // Prove by showing a valid transition passes AND an invalid one fails.
    const p = mkProject()
    p.tracks[0].layers = [
      colorLayer('aaa', 0, 1_000_000),
      colorLayer('bbb', 800_000, 1_800_000),
    ]
    // Valid: 200µs overlap authorized.
    p.transitions.push({ id: 'tr1', from_layer: 'aaa', to_layer: 'bbb', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    p.composition.duration_us = 1_800_000
    expect(() => validate(p)).not.toThrow()

    // Now change the overlap to 300µs without updating the transition → mismatch.
    const p2 = mkProject()
    p2.tracks[0].layers = [
      colorLayer('aaa', 0, 1_000_000),
      colorLayer('bbb', 700_000, 1_700_000), // overlap = 300_000
    ]
    p2.transitions.push({ id: 'tr1', from_layer: 'aaa', to_layer: 'bbb', duration_us: 200_000, kind: { kind: 'Crossfade' } })
    p2.composition.duration_us = 1_700_000
    expect(() => validate(p2)).toThrow(ValidationFailure)
  })
})
