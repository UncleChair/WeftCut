// apps/desktop/src/main/state/mutations/groups.test.ts (read-side helpers)
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { indexGroups, groupSiblingsExcluding, checkGroupLock, layerIdSet } from './groups'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function withTwo(): Project {
  const p = blankProject(seededGen(), 't')
  p.tracks[0].layers = [color('a', 0, 100), color('b', 200, 300)]
  p.groups = [{ id: 'g', members: ['a', 'b'] }]
  return p
}

describe('group read-side helpers', () => {
  it('indexGroups maps each member to its group', () => {
    const m = indexGroups([{ id: 'g', members: ['a', 'b'] }])
    expect(m.get('a')).toBe('g'); expect(m.get('b')).toBe('g'); expect(m.get('x')).toBeUndefined()
  })
  it('groupSiblingsExcluding returns the other members, sorted, [] when ungrouped', () => {
    const p = withTwo()
    expect(groupSiblingsExcluding(p, 'a')).toEqual(['b'])
    expect(groupSiblingsExcluding(p, 'b')).toEqual(['a'])
    p.groups = []
    expect(groupSiblingsExcluding(p, 'a')).toEqual([])
  })
  it('layerIdSet collects all layer ids', () => {
    const p = withTwo(); expect([...layerIdSet(p)].sort()).toEqual(['a', 'b'])
  })
  it('checkGroupLock: ungrouped anchor is a no-op', () => {
    const p = withTwo(); p.groups = []
    expect(() => checkGroupLock(p, 'a', ['a', 'b'])).not.toThrow()
  })
  it('checkGroupLock throws GroupLockedMember when a touched member is layer-locked', () => {
    const p = withTwo(); p.tracks[0].layers[1].locked = true // 'b' locked
    try { checkGroupLock(p, 'a', ['a', 'b']); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('GroupLockedMember') }
  })
  it('checkGroupLock throws TrackLocked when a touched member sits on a locked track', () => {
    const p = withTwo()
    // move 'b' to B-roll and lock that track
    p.tracks[0].layers = [color('a', 0, 100)]
    p.tracks[1].layers = [color('b', 200, 300)]; p.tracks[1].locked = true
    try { checkGroupLock(p, 'a', ['a', 'b']); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})
