import { describe, it, expect } from 'vitest'
import { cueToTextParams, applyAddCaptionTrack, applyRestyleCaptions, type Cue, type CueStyle } from './captions'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import type { TextParams } from '../model'

const cue = (style: CueStyle = {}): Cue => ({ start_us: 0, end_us: 1, text: 'hi', style })

describe('cueToTextParams (mirror subtitles/layout.rs)', () => {
  it('styleless cue → bottom-center default look', () => {
    const p = cueToTextParams(cue(), 1920, 1080)
    expect(p.font.family).toBe('Liberation Sans, Noto Sans SC')
    expect(p.font.size_px).toBe(54) // round(1080 * 0.05)
    expect(p.outline).not.toBeNull()
    expect(p.shadow).not.toBeNull()
    expect(p.transform.anchor).toEqual([0.5, 1.0]) // an2 bottom-center
    expect(p.transform.x).toEqual({ mode: 'Static', value: 960 }) // w/2
    expect((p.transform.y as { value: number }).value).toBeCloseTo(1080 - 1080 * 0.08, 5) // h - 8%
    expect(p.align).toBe('Center')
    expect(p.backend_hint).toBe('DrawText')
  })
  it('an8 → top-center anchors top', () => {
    expect(cueToTextParams(cue({ align: 8 }), 1920, 1080).transform.anchor).toEqual([0.5, 0.0])
  })
  it('an1 → bottom-left, Left align', () => {
    const p = cueToTextParams(cue({ align: 1 }), 1920, 1080)
    expect(p.transform.anchor).toEqual([0.0, 1.0])
    expect(p.align).toBe('Left')
  })
  it('explicit pos overrides the computed base position', () => {
    const p = cueToTextParams(cue({ align: 5, pos: [100, 200] }), 1920, 1080)
    expect([p.transform.x, p.transform.y]).toEqual([{ mode: 'Static', value: 100 }, { mode: 'Static', value: 200 }])
  })
  it('explicit clean style: bold/italic + size/outline', () => {
    const p = cueToTextParams(cue({ size_px: 54, bold: true, italic: true, outline_px: 3, shadow_px: 2 }), 1920, 1080)
    expect([p.font.size_px, p.font.weight, p.font.italic]).toEqual([54, 700, true])
    expect((p.outline as { width: number }).width).toBe(3)
    expect((p.shadow as { blur: number }).blur).toBe(2)
  })
})

const CLEAN: CueStyle = { size_px: 54, outline_px: 3, shadow_px: 2 } // explicit ⇒ no f32 multiply

describe('applyAddCaptionTrack', () => {
  // blankProject consumes #1 A-roll, #2 B-roll, #3 project (no actor/History here).
  function blank() { const gen = seededGen(); return { p: blankProject(gen, 'c'), gen } }
  it('one cue → a Caption track appended after B-roll with one Text layer, returns the primary id', () => {
    const { p, gen } = blank()
    const tid = applyAddCaptionTrack(p, gen, [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], 1920, 1080, 'Captions')
    expect(tid).toBe('00000000-0000-0000-0000-000000000004') // track id #4 (Track::new first), layer #5
    expect(p.tracks.map((t) => t.id).slice(2)).toEqual([tid]) // appended after [A, B]
    const ct = p.tracks[2]
    expect([ct.role, ct.label, ct.removable, ct.transient]).toEqual(['Caption', 'Captions', true, false])
    expect(ct.layers).toHaveLength(1)
    expect(ct.layers[0].params.kind).toBe('Text')
  })
  it('two overlapping cues open two lanes; a third non-overlapping cue reuses lane 1', () => {
    const { p, gen } = blank()
    applyAddCaptionTrack(p, gen, [
      { start_us: 0, end_us: 2_000_000, text: 'a', style: CLEAN },        // lane1: end 2s
      { start_us: 1_000_000, end_us: 3_000_000, text: 'b', style: CLEAN }, // overlaps lane1 (2s>1s) → lane2
      { start_us: 2_000_000, end_us: 3_000_000, text: 'c', style: CLEAN }, // lane1 end 2s <= 2s → reuse lane1
    ], 1920, 1080, null)
    const caps = p.tracks.filter((t) => t.role === 'Caption')
    expect(caps).toHaveLength(2)
    expect(caps[0].layers.map((l) => (l.params as { content: string }).content)).toEqual(['a', 'c'])
    expect(caps[1].layers.map((l) => (l.params as { content: string }).content)).toEqual(['b'])
  })
  it('empty cues → one empty Caption track (raw-contract safety net)', () => {
    const { p, gen } = blank()
    const tid = applyAddCaptionTrack(p, gen, [], 1920, 1080, 'X')
    expect(p.tracks[2].id).toBe(tid)
    expect([p.tracks[2].role, p.tracks[2].layers.length]).toEqual(['Caption', 0])
  })
})

describe('applyRestyleCaptions (project-wide)', () => {
  // Two overlapping cues lane-pack into TWO caption tracks — the cross-track
  // corpus the project-wide restyle must cover in one pass.
  function twoLaneProject() {
    const gen = seededGen(); const p = blankProject(gen, 'c')
    applyAddCaptionTrack(p, gen, [
      { start_us: 0, end_us: 2_000_000, text: 'a', style: CLEAN },        // lane1
      { start_us: 1_000_000, end_us: 3_000_000, text: 'b', style: CLEAN }, // lane2 (overlaps)
    ], 1920, 1080, null)
    return p
  }

  it('patches Text layers on EVERY caption-role track, not just the first', () => {
    const p = twoLaneProject()
    const caps = p.tracks.filter((t) => t.role === 'Caption')
    expect(caps).toHaveLength(2)
    applyRestyleCaptions(p, { font_family: 'Arial', font_size_px: 72, outline_width: 4 })
    for (const track of caps) {
      for (const layer of track.layers) {
        const tp = layer.params as TextParams
        expect([tp.font.family, tp.font.size_px]).toEqual(['Arial', 72])
        // outline_width keeps the existing outline color (BLACK from the seed).
        expect(tp.outline).toEqual({ color: { r: 0, g: 0, b: 0, a: 255 }, width: 4 })
      }
    }
  })

  it('leaves non-caption tracks untouched', () => {
    const p = twoLaneProject()
    // A-roll is a non-caption track from blankProject; give it a Text layer.
    const aRoll = p.tracks.find((t) => t.role === 'ARoll')!
    aRoll.layers.push({
      id: 'x', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false,
      metadata: {},
      params: cueToTextParams({ start_us: 0, end_us: 1, text: 'not a caption', style: CLEAN }, 1920, 1080),
      effects: [],
    })
    const before = (aRoll.layers[0].params as TextParams).font.size_px
    applyRestyleCaptions(p, { font_size_px: 99 })
    expect((aRoll.layers[0].params as TextParams).font.size_px).toBe(before)
  })

  it('no-op (no throw) when the project has zero caption tracks', () => {
    const gen = seededGen(); const p = blankProject(gen, 'c')
    expect(p.tracks.some((t) => t.role === 'Caption')).toBe(false)
    expect(() => applyRestyleCaptions(p, { font_size_px: 60 })).not.toThrow()
  })
})
