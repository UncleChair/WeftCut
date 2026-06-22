// apps/desktop/src/main/state/mutations/split.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applySplitLayer } from './split'
import { applyGroupsCreate } from './groups'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function one(): Project {
  const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [color('a', 0, 1_000_000)]; return p
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}

describe('applySplitLayer', () => {
  it('splits a layer into left[0,t) + right[t,end); right gets a fresh id; left keeps id', () => {
    const p = one()
    const r = applySplitLayer(p, seededGen(), 'a', 400_000, false)
    expect(r.left).toBe('a')
    const layers = p.tracks[0].layers
    expect(layers.length).toBe(2)
    expect(layers[0].id).toBe('a'); expect(layers[0].t_start_us).toBe(0)
    expect(layers[1].id).toBe(r.right)
    expect(layers[1].t_start_us).toBe(layers[0].t_end_us) // contiguous at the split point
    expect(layers[1].t_end_us).toBe(1_000_000)
  })
  it('rejects a split at/outside the layer bounds', () => {
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 0, false), 'SplitOutsideLayer')
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 1_000_000, false), 'SplitOutsideLayer')
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 2_000_000, false), 'SplitOutsideLayer')
  })
  it('rejects a missing layer and a locked track', () => {
    expectCmd(() => applySplitLayer(one(), seededGen(), 'ghost', 100, false), 'LayerNotFound')
    const p = one(); p.tracks[0].locked = true
    expectCmd(() => applySplitLayer(p, seededGen(), 'a', 400_000, false), 'TrackLocked')
  })
  it('partitions src_in/src_out for media kinds', () => {
    const p = blankProject(seededGen(), 't')
    const vid: Layer = { id: 'v', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {},
      params: { kind: 'VideoClip', media: 'm', src_in_us: 500_000, src_out_us: 1_500_000, transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor: [0, 0] } as any, opacity: { mode: 'Static', value: 1 }, crop: null } as any, effects: [] }
    p.tracks[0].layers = [vid]
    applySplitLayer(p, seededGen(), 'v', 400_000, false) // offset 400_000
    const [l, rr] = p.tracks[0].layers as any
    expect(l.params.src_out_us).toBe(900_000)  // src_in(500k) + offset(400k)
    expect(rr.params.src_in_us).toBe(900_000)  // src_in(500k) + offset(400k)
    expect(rr.params.src_out_us).toBe(1_500_000)
  })
  it('group spanning split: both halves stay in the group; non-spanning members untouched', () => {
    const p = blankProject(seededGen(), 't')
    // a:[0,1s] and b:[0,1s] on track B grouped; both span t=400k
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)]
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    const r = applySplitLayer(p, seededGen(), 'a', 400_000, false)
    const group = p.groups.find((g) => g.id === gid)!
    // a's right-half + b's right-half both joined the group → 4 members
    expect(group.members.length).toBe(4)
    expect(group.members).toContain(r.right)
    expect(p.tracks[1].layers.length).toBe(2) // b was spanning → split too
  })
  it('escape_group splits only the target (sibling not split), but the target stays grouped so its right-half joins', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)]
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    const r = applySplitLayer(p, seededGen(), 'a', 400_000, true)
    expect(p.tracks[1].layers.length).toBe(1) // sibling b NOT split (escape → no spanning fan-out)
    const group = p.groups.find((g) => g.id === gid)!
    expect(group.members.length).toBe(3) // target stays grouped; its right-half joins (mutations.rs:779-787)
    expect(group.members).toContain(r.right)
    expect(group.members).toContain('b')
  })
  it('splitTrackHalf retains left keyframes and collapses an emptied right half to Static at the boundary value', () => {
    const p = blankProject(seededGen(), 't')
    const c: Layer = {
      id: 'c', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {},
      params: { kind: 'Color', width: 1, height: 1, color: { mode: 'Keyframed', value: [
        { id: 'k0', t_us: 0, value: { r: 10, g: 0, b: 0, a: 255 }, interp: { kind: 'Linear' } },
        { id: 'k1', t_us: 100_000, value: { r: 20, g: 0, b: 0, a: 255 }, interp: { kind: 'Linear' } },
      ] } }, effects: [],
    }
    p.tracks[0].layers = [c]
    applySplitLayer(p, seededGen(), 'c', 400_000, false) // offset = 400_000
    const left = p.tracks[0].layers[0].params
    const right = p.tracks[0].layers[1].params
    // LEFT keeps keyframes with t <= 400_000 → both retained, still Keyframed.
    expect(left.kind === 'Color' && left.color.mode).toBe('Keyframed')
    expect(left.kind === 'Color' && (left.color.mode === 'Keyframed' ? left.color.value.length : -1)).toBe(2)
    // RIGHT keeps t > 400_000 → none → collapses to Static at the LAST keyframe value (r:20).
    expect(right.kind === 'Color' && JSON.stringify(right.color)).toBe(JSON.stringify({ mode: 'Static', value: { r: 20, g: 0, b: 0, a: 255 } }))
  })
})
