import { describe, it, expect } from 'vitest'
import type { Layer, LayerParams, MediaItem, Rgba, Track } from './model'
import {
  layerKind, deriveTrackKindLabel, layerColorHint, hslToHex, markerColorHint, mediaLabel, layerParamsView,
  buildProjectSummary,
} from './summary'
import { seededGen } from './ids'
import { blankProject } from './model'
import { createActor } from './actor'

const stat = <T>(value: T) => ({ mode: 'Static' as const, value })
const xf = () => ({ x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), rotation_deg: stat(0), anchor: [0.5, 0.5] as [number, number] })
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
      transform: { ...xf(), anchor: [0.5, 1.0] }, opacity: stat(1),
      shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
      outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
      intro: null, outro: null, backend_hint: 'DrawText',
    }
    const v = layerParamsView(tp, {})
    expect(v.kind).toBe('Text')
    if (v.kind !== 'Text') throw new Error('unreachable')
    expect([v.font_family, v.font_size_px, v.weight, v.italic]).toEqual(['Liberation Sans', 54, 700, true])
    expect([v.anchor_x, v.anchor_y]).toEqual([0.5, 1.0])
    expect(v.align).toBe('Center')
    expect([v.scale_x, v.scale_y, v.rotation_deg]).toEqual([stat(1), stat(1), stat(0)])
    expect(v.outline).not.toBeNull()
    expect(v.shadow).not.toBeNull()
  })
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
    expect(s.composition).toEqual({ width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false })
    expect(s.audio_roles.map((r) => r.role)).toEqual(['dialogue', 'music', 'sfx', 'voiceover']) // ALL order
    expect(s.audio_roles[0]).toEqual({ role: 'dialogue', gain_db: 0, muted: false, solo: false }) // defaults filled
    expect([s.history.cursor, s.history.len, s.history.can_undo, s.history.can_redo]).toEqual([0, 1, false, false])
    expect(s.history.lock_reason).toBeUndefined() // skip_serializing_if=Option::is_none → absent
    expect([s.media, s.markers, s.groups]).toEqual([[], [], []])
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
    // blankProject reserves two tracks: A roll (ARoll) and B roll (BRoll)
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
    shadow: null, outline: null, intro: null, outro: null, backend_hint: 'Auto',
  }
}
