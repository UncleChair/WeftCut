import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddLayer } from './add'
import { isCommandFailure } from '../errors'
import { videoClipParams, audioParams, imageOverlayParams, applySeparateAudio, mediaItemTemplate } from './media'

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
