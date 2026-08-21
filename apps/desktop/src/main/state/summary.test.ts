import { describe, it, expect } from 'vitest'
import type { Animated, Layer, LayerParams, MediaItem, Rgba, Track } from './model'
import {
  layerKind, deriveTrackKindLabel, layerColorHint, hslToHex, markerColorHint, mediaLabel, layerParamsView,
  buildProjectSummary,
} from './summary'
import { seededGen } from './ids'
import { blankProject } from './model'
import { createActor } from './actor'

const stat = <T>(value: T) => ({ mode: 'Static' as const, value })
const xf = () => ({ x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), rotation_deg: stat(0), anchor_x: stat(0.5), anchor_y: stat(0.5), scale_linked: true })
function layer(id: string, params: LayerParams): Layer {
  return { id, label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function track(layers: Layer[]): Track {
  return { id: 't', label: null, enabled: true, locked: false, muted: false, solo: false, removable: true, role: null, transient: false, height_px: 64, layers }
}
const color = (rgba: Rgba): LayerParams => ({ kind: 'Color', color: stat(rgba), width: 1920, height: 1080 })

describe('hslToHex (mirror commands/mod.rs:647 hsl_to_hex)', () => {
  it('det-mode hue 0 is the constant #cb4d4d', () => {
    // c=(1-|2*.55-1|)*.55=.495, x=0, m=.3025 → R=round(.7975*255)=203, G=B=round(.3025*255)=77
    expect(hslToHex(0, 0.55, 0.55)).toBe('#cb4d4d')
  })
})

describe('layerColorHint (commands/mod.rs:629)', () => {
  it('Color layer uses its exact rgba hex', () => {
    expect(layerColorHint(layer('x', color({ r: 0x12, g: 0x34, b: 0x56, a: 255 })))).toBe('#123456')
  })
  it('Color layer with a keyframed color uses the first keyframe value', () => {
    const kf: LayerParams = { kind: 'Color', color: { mode: 'Keyframed', value: [{ id: 'k', t_us: 0, value: { r: 1, g: 2, b: 3, a: 255 }, interp: { kind: 'Linear' } }] }, width: 16, height: 16 }
    expect(layerColorHint(layer('x', kf))).toBe('#010203')
  })
  it('det-mode id (leading bytes 00 00) → hue 0 → #cb4d4d for a non-Color layer', () => {
    expect(layerColorHint(layer('00000000-0000-0000-0000-000000000005', { kind: 'Text', ...textParamsLite() }))).toBe('#cb4d4d')
  })
})

describe('layerKind / deriveTrackKindLabel', () => {
  it('layerKind returns the discriminant', () => {
    expect(layerKind(color({ r: 0, g: 0, b: 0, a: 255 }))).toBe('Color')
  })
  it('a track with a visual layer is "Video"', () => {
    expect(deriveTrackKindLabel(track([layer('a', color({ r: 0, g: 0, b: 0, a: 255 }))]))).toBe('Video')
  })
  it('an audio-only track is "Audio"', () => {
    const audio: LayerParams = { kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: 1, gain_db: stat(0), pan: stat(0), fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' }
    expect(deriveTrackKindLabel(track([layer('a', audio)]))).toBe('Audio')
  })
  it('an empty track is "Video"', () => {
    expect(deriveTrackKindLabel(track([]))).toBe('Video')
  })
})

describe('markerColorHint / mediaLabel', () => {
  it('markerColorHint formats #rrggbb', () => {
    expect(markerColorHint({ r: 0, g: 128, b: 255, a: 255 })).toBe('#0080ff')
  })
  it('mediaLabel falls back to the path basename when label is null', () => {
    expect(mediaLabel({ path_abs: 'media/clip.bin', label: null } as MediaItem)).toBe('clip.bin')
  })
  it('mediaLabel prefers an explicit label', () => {
    expect(mediaLabel({ path_abs: 'media/clip.bin', label: 'My Clip' } as MediaItem)).toBe('My Clip')
  })
})

describe('layerParamsView Text arm (mirror text_view_tests)', () => {
  it('carries font/weight/italic/align/anchor/outline/shadow', () => {
    const tp: LayerParams = {
      kind: 'Text', content: 'hi',
      font: { family: 'Liberation Sans', size_px: 54, weight: 700, italic: true },
      color: stat({ r: 255, g: 255, b: 255, a: 255 }), align: 'Center',
      transform: { ...xf(), anchor_x: { mode: 'Static', value: 0.5 }, anchor_y: { mode: 'Static', value: 1.0 } }, opacity: stat(1),
      shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
      outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
      intro: null, outro: null,
      box_w: null, box_h: null, valign: 'Middle', line_height: 0, letter_spacing: 0,
    }
    const v = layerParamsView(tp, {})
    expect(v.kind).toBe('Text')
    if (v.kind !== 'Text') throw new Error('unreachable')
    expect([v.font_family, v.font_size_px, v.weight, v.italic]).toEqual(['Liberation Sans', 54, 700, true])
    expect([v.anchor_x, v.anchor_y]).toEqual([stat(0.5), stat(1.0)])
    expect(v.align).toBe('Center')
    expect([v.scale_x, v.scale_y, v.rotation_deg]).toEqual([stat(1), stat(1), stat(0)])
    expect(v.outline).not.toBeNull()
    expect(v.shadow).not.toBeNull()
  })

  it('forwards the layout box, both nulls included', () => {
    // Which box fields are set IS the resize mode, so this projection is the
    // one place a dropped field would read as a different mode downstream —
    // Fixed arriving as Auto width wraps and places the block differently.
    const tp = (box: { box_w: number | null; box_h: number | null }): LayerParams => ({
      kind: 'Text', ...textParamsLite(), ...box, valign: 'Bottom', line_height: 72, letter_spacing: 4,
    })
    const fixed = layerParamsView(tp({ box_w: 640, box_h: 300 }), {})
    if (fixed.kind !== 'Text') throw new Error('unreachable')
    expect([fixed.box_w, fixed.box_h]).toEqual([640, 300])
    expect([fixed.valign, fixed.line_height, fixed.letter_spacing]).toEqual(['Bottom', 72, 4])

    const auto = layerParamsView(tp({ box_w: null, box_h: null }), {})
    if (auto.kind !== 'Text') throw new Error('unreachable')
    expect([auto.box_w, auto.box_h]).toEqual([null, null])
  })
})

describe('layerParamsView carries the transform anchor on every visual kind', () => {
  // The renderer pivots rotation and flip on `anchor_x`/`anchor_y`
  // (render/anchorPivot.ts). Absent on the wire, it falls back to the 0.5
  // default — correct-looking, but it would silently ignore a real per-layer
  // anchor. This gates the projection, so a discrepancy in a running app can
  // only be a stale main process, never missing code.
  //
  // The pair projects as WHOLE TRACKS, not resolved scalars: the anchor is
  // keyframeable, and resolving it here would strand the inspector's stopwatch
  // and the timeline's anchor lanes with nothing to read.
  const cases: Array<[string, LayerParams]> = [
    ['VideoClip', { kind: 'VideoClip', media: 'm', src_in_us: 0, src_out_us: 1, transform: { ...xf(), anchor_x: { mode: 'Static', value: 0.25 }, anchor_y: { mode: 'Static', value: 0.75 } }, opacity: stat(1), speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0, crop: null } as unknown as LayerParams],
    ['ImageOverlay', { kind: 'ImageOverlay', media: 'm', transform: { ...xf(), anchor_x: { mode: 'Static', value: 0.25 }, anchor_y: { mode: 'Static', value: 0.75 } }, opacity: stat(1), fade_in_us: 0, fade_out_us: 0 } as unknown as LayerParams],
    ['Motif', { kind: 'Motif', motif_id: 'countdown', motif_version: 1, props: {}, src_in_us: 0, transform: { ...xf(), anchor_x: { mode: 'Static', value: 0.25 }, anchor_y: { mode: 'Static', value: 0.75 } }, opacity: stat(1) } as unknown as LayerParams],
  ]
  for (const [kind, params] of cases) {
    it(`${kind} view exposes anchor_x/anchor_y`, () => {
      const v = layerParamsView(params, {}) as unknown as { anchor_x: Animated<number>; anchor_y: Animated<number> }
      expect([v.anchor_x, v.anchor_y]).toEqual([stat(0.25), stat(0.75)])
    })
  }
})

const NEVER = () => false // gate/test fileExists predicate

describe('buildProjectSummary (mirror commands/mod.rs:322 build_project_summary)', () => {
  it('blank project: counts, composition, canonical roles, history', () => {
    const gen = seededGen()
    const initial = blankProject(gen, 'demo')
    const actor = createActor({ initial, idGen: gen, clock: () => '<TS>' })
    const s = buildProjectSummary(actor.snapshot(), actor.historyStatus(), NEVER)
    expect(s.name).toBe('demo')
    expect([s.track_count, s.layer_count]).toEqual([2, 0]) // A-roll + B-roll, no layers
    // fps_locked false on a blank project: nothing in the stack has ever held a layer.
    expect(s.composition).toEqual({ width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false, fps_locked: false })
    expect(s.audio_roles.map((r) => r.role)).toEqual(['dialogue', 'music', 'sfx', 'voiceover']) // ALL order
    expect(s.audio_roles[0]).toEqual({ role: 'dialogue', gain_db: 0, muted: false, solo: false }) // defaults filled
    expect([s.history.cursor, s.history.len, s.history.can_undo, s.history.can_redo]).toEqual([0, 1, false, false])
    expect(s.history.lock_reason).toBeUndefined() // skip_serializing_if=Option::is_none → absent
    expect([s.media, s.markers, s.groups]).toEqual([[], [], []])
  })
  /// The settings panel disables its rate control off this one flag, so it has to
  /// carry the HISTORY-scoped truth, not just "are there layers right now".
  it('composition.fps_locked follows the stored history, not the live layer count', () => {
    const gen = seededGen()
    const initial = blankProject(gen, 'lock')
    const actor = createActor({ initial, idGen: gen, clock: () => '<TS>' })
    const added = actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(buildProjectSummary(actor.snapshot(), actor.historyStatus(), NEVER).composition.fps_locked).toBe(true)

    // Delete it: the timeline is empty again, but undo still reaches the layer.
    expect(actor.dispatch('delete_layer', { layer: added.ok ? added.value : '' }).ok).toBe(true)
    const s = buildProjectSummary(actor.snapshot(), actor.historyStatus(), NEVER)
    expect(s.layer_count).toBe(0)
    expect(s.composition.fps_locked).toBe(true)
  })

  it('a built project: track kind, layer kind/color_hint, media sorted desc + label', () => {
    const gen = seededGen()
    const initial = blankProject(gen, 'demo')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen: gen, clock: () => '<TS>' })
    actor.dispatch('add_media', { id: '00000000-0000-0000-0000-0000000000aa', kind: 'Video', duration_us: 5_000_000 })
    actor.dispatch('add_media', { id: '00000000-0000-0000-0000-0000000000bb', kind: 'Audio', duration_us: 3_000_000 })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    const s = buildProjectSummary(actor.snapshot(), actor.historyStatus(), NEVER)
    expect(s.media.map((m) => m.id)).toEqual([ // descending by id string
      '00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000aa',
    ])
    expect(s.media[0]).toMatchObject({ label: 'clip.bin', kind: 'Audio', available: false, decode_route: { route: 'bypass' } })
    const t0 = s.tracks[0]
    expect(t0.kind).toBe('Video')
    expect(t0.layers[0].kind).toBe('Color')
    expect(t0.layers[0].color_hint).toBe('#ff0000') // default add_layer color is red (255,0,0)
    expect(s.layer_count).toBe(1)
  })
  it('track roles emit kebab wire form (ARoll→a-roll, BRoll→b-roll)', () => {
    // blankProject reserves two role-stamped tracks, ARoll and BRoll. Neither
    // stores a label — the role IS the name, resolved renderer-side.
    const gen = seededGen()
    const initial = blankProject(gen, 'demo')
    const actor = createActor({ initial, idGen: gen, clock: () => '<TS>' })
    const s = buildProjectSummary(actor.snapshot(), actor.historyStatus(), NEVER)
    expect(s.tracks.map((t) => t.role)).toEqual(['a-roll', 'b-roll'])
  })
})

// minimal Text params for the color-hint test above
function textParamsLite(): Omit<Extract<LayerParams, { kind: 'Text' }>, 'kind'> {
  return {
    content: '', font: { family: 'f', size_px: 10, weight: 400, italic: false },
    color: stat({ r: 0, g: 0, b: 0, a: 255 }), align: 'Center', transform: xf(), opacity: stat(1),
    shadow: null, outline: null, intro: null, outro: null,
    box_w: null, box_h: null, valign: 'Middle', line_height: 0, letter_spacing: 0,
  }
}
