import { describe, it, expect } from 'vitest'
import { cueToTextParams, type Cue, type CueStyle } from './captions'

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
