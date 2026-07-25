import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, applyAddTrack, colorParams } from './add'
import { applyDeleteLayer } from './delete'
import { applyDuplicateLayer } from './duplicate'
import { isCommandFailure } from '../errors'
import { validate } from '../validate'

describe('delete + duplicate', () => {
  it('deletes a layer and autofits', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 2_000_000)
    expect(applyDeleteLayer(p, a)).toBeNull() // A-roll not removable
    expect(p.tracks[0].layers).toHaveLength(0)
    expect(p.composition.duration_us).toBe(0)
  })
  it('auto-deletes an emptied removable track and reports its id', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const tx = applyAddTrack(p, g, 'X')
    const a = applyAddLayer(p, g, tx, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    expect(applyDeleteLayer(p, a)).toBe(tx)
    expect(p.tracks.find((t) => t.id === tx)).toBeUndefined()
  })
  it('rejects deleting a missing layer / locked track', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyDeleteLayer(p, 'ghost'); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
  })
  it('duplicates with a fresh id, offset, sorted insert, and no group join', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    const dup = applyDuplicateLayer(p, g, a, 2_000_000)
    expect(dup).not.toBe(a)
    const copy = p.tracks[0].layers.find((l) => l.id === dup)!
    expect(copy.t_start_us).toBe(2_000_000); expect(copy.t_end_us).toBe(3_000_000)
    expect(p.groups).toHaveLength(0)
  })
  it('snaps the duplicate onto the frame grid at a fractional rate', () => {
    // `t_offset_us` arrives raw (duplicate_layer is MCP-only), so `+=` on both
    // edges left them off the grid at every rational rate. Both edges now come out
    // of the same snap-the-start-then-carry-the-delta model as paste.
    const g = seededGen(); const p = blankProject(g, 't')
    p.composition.fps = { num: 30000, den: 1001 }
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 100_100)
    const dup = applyDuplicateLayer(p, g, a, 500_000) // 500_000 µs is NOT a boundary at 29.97
    const copy = p.tracks[0].layers.find((l) => l.id === dup)!
    expect(copy.t_start_us).toBe(500_500) // frame 15
    expect(copy.t_end_us).toBe(600_600)   // frame 18 — the source's 3-frame span, preserved
    expect(() => validate(p)).not.toThrow()
  })
})
