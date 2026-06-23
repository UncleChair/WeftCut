import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project, type MediaItem } from '../model'
import { applyAddLayer } from './add'
import { isCommandFailure } from '../errors'
import { videoClipParams, audioParams, imageOverlayParams, applySeparateAudio, mediaItemTemplate, applySetMediaDerivatives, applySetMediaWorkspacePaths, referencingLayers } from './media'

const MID = '00000000-0000-0000-0000-0000000000aa'
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}

describe('media param builders', () => {
  it('videoClipParams: defaults match add_media_layer (transform/opacity/crop/flip/blend/speed/fades)', () => {
    const p = videoClipParams(MID, 0, 4_000_000)
    expect(p).toEqual({ kind: 'VideoClip', media: MID, src_in_us: 0, src_out_us: 4_000_000,
      transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 },
        scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor: [0.5, 0.5] },
      opacity: { mode: 'Static', value: 1 }, crop: null, flip_h: false, flip_v: false, blend_mode: 'Normal',
      speed: 1, fade_in_us: 0, fade_out_us: 0 })
  })
  it('audioParams: standalone role is music (kebab-case wire form), gain/pan 0', () => {
    const p = audioParams(MID, 0, 3_000_000) as Extract<ReturnType<typeof audioParams>, { kind: 'Audio' }>
    expect([p.kind, p.role, p.gain_db, p.pan, p.mute]).toEqual(['Audio', 'music', { mode: 'Static', value: 0 }, { mode: 'Static', value: 0 }, false])
  })
  it('imageOverlayParams: no src range, blend Normal', () => {
    const p = imageOverlayParams(MID) as Extract<ReturnType<typeof imageOverlayParams>, { kind: 'ImageOverlay' }>
    expect([p.kind, p.media, p.blend_mode, p.fade_in_us]).toEqual(['ImageOverlay', MID, 'Normal', 0])
  })
})

describe('mediaItemTemplate', () => {
  it('builds a fixed-defaults pool item with an explicit-null metadata trio', () => {
    const it1 = mediaItemTemplate(MID, 'Video', 4_000_000)
    expect(it1.metadata).toEqual({ duration_us: 4_000_000, video: null, audio: null, container_format: null })
    expect([it1.path_abs, it1.file_hash_blake3, it1.proxy_bypassed, it1.proxy_format_version]).toEqual(['media/clip.bin', '0', false, 0])
  })
})

describe('applySeparateAudio', () => {
  /** A-roll holds one Audio layer L1 (id #6 — #1-3 blank, #4 Initial NOT consumed here, see note). */
  function withAudio(): { p: Project; gen: IdGen; a1: string } {
    const gen = seededGen()
    const p = blankProject(gen, 's') // #1 A #2 B #3 project
    const a1 = applyAddLayer(p, gen, p.tracks[0].id, audioParams('00000000-0000-0000-0000-0000000000aa', 0, 3_000_000), 0, 3_000_000) // #4
    return { p, gen, a1 }
  }
  it('lifts the audio layer onto a new track inserted before the source, labelled "<src> (audio)"', () => {
    const { p, gen, a1 } = withAudio()
    expect(p.tracks[0].layers.map((l) => l.id)).toEqual([a1]) // A roll holds it
    const newTrack = applySeparateAudio(p, gen, a1) // #5
    expect(newTrack).toBe('00000000-0000-0000-0000-000000000005')
    // new track inserted at the source index (0) → [newAudio, A, B]
    expect(p.tracks[0].id).toBe(newTrack)
    expect(p.tracks[0].label).toBe('A roll (audio)')
    expect(p.tracks[0].layers.map((l) => l.id)).toEqual([a1]) // layer moved here
    expect(p.tracks[0].removable).toBe(true)
    expect(p.tracks[1].layers).toEqual([]) // A roll now empty
  })
  it('LayerNotFound (no id minted)', () => {
    const { p, gen } = withAudio()
    expectCmd(() => applySeparateAudio(p, gen, 'ghost'), 'LayerNotFound')
    // gen un-advanced: next add_layer id is #5 (not #6)
    expect(applyAddLayer(p, gen, p.tracks[1].id, audioParams('00000000-0000-0000-0000-0000000000aa', 0, 1_000_000), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000005')
  })
  it('WrongLayerKind on a non-audio layer (no id minted)', () => {
    const gen = seededGen()
    const p = blankProject(gen, 's')
    const c1 = applyAddLayer(p, gen, p.tracks[0].id, videoClipParams('00000000-0000-0000-0000-0000000000aa', 0, 2_000_000), 0, 2_000_000) // #4 (video, not audio)
    expectCmd(() => applySeparateAudio(p, gen, c1), 'WrongLayerKind')
    expect(applyAddLayer(p, gen, p.tracks[1].id, audioParams('00000000-0000-0000-0000-0000000000aa', 0, 1_000_000), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000005') // no burn
  })
})

function pool1(): Record<string, MediaItem> {
  return { [MID]: mediaItemTemplate(MID, 'Video', 4_000_000) }
}

describe('applySetMediaDerivatives', () => {
  it('MediaNotFound when id absent (throws CommandFailure)', () => {
    expectCmd(() => applySetMediaDerivatives({}, MID, { proxy_path: 'media/p.mp4' }), 'MediaNotFound')
  })
  it('sets every field; tri-state proxy keys set when string', () => {
    const out = applySetMediaDerivatives(pool1(), MID, {
      proxy_path: 'media/p.mp4', quick_proxy_path: 'media/q.mp4', proxy_format_version: 3,
      proxy_bypassed: true, export_uses_original: true,
      waveform_path: 'media/w.bin', conform_path: 'media/c.wav', thumbnails_dir: 'media/t' })[MID]
    expect([out.proxy_path, out.quick_proxy_path, out.proxy_format_version, out.proxy_bypassed,
      out.export_uses_original, out.waveform_path, out.conform_path, out.thumbnails_dir])
      .toEqual(['media/p.mp4', 'media/q.mp4', 3, true, true, 'media/w.bin', 'media/c.wav', 'media/t'])
  })
  it('null clears the tri-state proxy fields', () => {
    const set = applySetMediaDerivatives(pool1(), MID, { proxy_path: 'media/p.mp4', quick_proxy_path: 'media/q.mp4' })
    const out = applySetMediaDerivatives(set, MID, { proxy_path: null, quick_proxy_path: null })[MID]
    expect([out.proxy_path, out.quick_proxy_path]).toEqual([null, null])
  })
  it('absent proxy key leaves the existing value (does not clear)', () => {
    const set = applySetMediaDerivatives(pool1(), MID, { proxy_path: 'media/p.mp4' })
    const out = applySetMediaDerivatives(set, MID, { proxy_format_version: 5 })[MID]
    expect([out.proxy_path, out.proxy_format_version]).toEqual(['media/p.mp4', 5])
  })
})

describe('applySetMediaWorkspacePaths', () => {
  it('MediaNotFound when id absent', () => {
    expectCmd(() => applySetMediaWorkspacePaths({}, MID, { path_abs: 'a', path_rel: 'r', file_hash_blake3: 'h', file_size: 1, file_mtime: 2 }), 'MediaNotFound')
  })
  it('sets all five workspace fields', () => {
    const out = applySetMediaWorkspacePaths(pool1(), MID, { path_abs: 'ws/clip.bin', path_rel: 'media/clip.bin', file_hash_blake3: 'abc', file_size: 1024, file_mtime: 1700000000 })[MID]
    expect([out.path_abs, out.path_rel, out.file_hash_blake3, out.file_size, out.file_mtime])
      .toEqual(['ws/clip.bin', 'media/clip.bin', 'abc', 1024, 1700000000])
  })
})

describe('referencingLayers', () => {
  it('finds VideoClip/Audio/ImageOverlay layers that reference the media id; ignores others', () => {
    const gen = seededGen()
    const p = blankProject(gen, 'r')
    const tA = p.tracks[0].id
    const v = applyAddLayer(p, gen, tA, videoClipParams(MID, 0, 4_000_000), 0, 4_000_000)
    applyAddLayer(p, gen, tA, videoClipParams('00000000-0000-0000-0000-0000000000bb', 0, 1), 5_000_000, 6_000_000)
    expect(referencingLayers(p, MID)).toEqual([v])
  })
})
