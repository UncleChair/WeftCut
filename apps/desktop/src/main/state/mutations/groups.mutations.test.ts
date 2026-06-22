// apps/desktop/src/main/state/mutations/groups.mutations.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyGroupsCreate, applyGroupsDissolve, applyGroupsAddMembers, applyGroupsRemoveMembers, applyGroupsRename } from './groups'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function withLayers(ids: string[]): Project {
  const p = blankProject(seededGen(), 't')
  p.tracks[0].layers = ids.map((id, i) => color(id, i * 1000, i * 1000 + 500))
  return p
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}

describe('group mutations', () => {
  it('create: rejects < 2 unique members', () => {
    const p = withLayers(['a'])
    expectCmd(() => applyGroupsCreate(p, seededGen(), ['a', 'a'], null, false), 'GroupCreateNeedsTwoLayers')
  })
  it('create: rejects a missing member', () => {
    const p = withLayers(['a', 'b'])
    expectCmd(() => applyGroupsCreate(p, seededGen(), ['a', 'ghost'], null, false), 'LayerNotFound')
  })
  it('create: makes a group with sorted members; label omitted when null', () => {
    const p = withLayers(['a', 'b'])
    const gen = seededGen()
    const gid = applyGroupsCreate(p, gen, ['b', 'a'], null, false)
    expect(p.groups.length).toBe(1)
    expect(p.groups[0].id).toBe(gid)
    expect([...p.groups[0].members].sort()).toEqual(['a', 'b'])
    expect('label' in p.groups[0]).toBe(false) // null → field omitted (serde None parity)
  })
  it('create: rejects an already-grouped layer unless reassign', () => {
    const p = withLayers(['a', 'b', 'c'])
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    expectCmd(() => applyGroupsCreate(p, seededGen(), ['b', 'c'], null, false), 'LayerAlreadyGrouped')
    // reassign moves 'b' to the new group; old group drops to 1 member → auto-dissolves
    applyGroupsCreate(p, seededGen(), ['b', 'c'], 'L', true)
    expect(p.groups.length).toBe(1)
    expect([...p.groups[0].members].sort()).toEqual(['b', 'c'])
    expect(p.groups[0].label).toBe('L')
  })
  it('dissolve: removes the group, errors when missing', () => {
    const p = withLayers(['a', 'b'])
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyGroupsDissolve(p, gid); expect(p.groups.length).toBe(0)
    expectCmd(() => applyGroupsDissolve(p, gid), 'GroupNotFound')
  })
  it('addMembers: adds; already-grouped→LayerAlreadyGrouped (before group existence); missing group→GroupNotFound', () => {
    const p = withLayers(['a', 'b', 'c', 'd'])
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyGroupsAddMembers(p, gid, ['c'], false)
    expect([...p.groups[0].members].sort()).toEqual(['a', 'b', 'c'])
    // Rust checks already-grouped BEFORE group existence (mutations.rs:234-277):
    // 'a' is grouped, target 'nope' missing, reassign=false → LayerAlreadyGrouped.
    expectCmd(() => applyGroupsAddMembers(p, 'nope', ['a'], false), 'LayerAlreadyGrouped')
    // 'd' is ungrouped → passes the already-grouped scan → reaches the missing-group check.
    expectCmd(() => applyGroupsAddMembers(p, 'nope', ['d'], false), 'GroupNotFound')
  })
  it('removeMembers: removes, auto-dissolves below 2, errors on non-member', () => {
    const p = withLayers(['a', 'b', 'c'])
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b', 'c'], null, false)
    applyGroupsRemoveMembers(p, gid, ['c'])
    expect([...p.groups[0].members].sort()).toEqual(['a', 'b'])
    expectCmd(() => applyGroupsRemoveMembers(p, gid, ['ghost']), 'LayerNotInGroup')
    applyGroupsRemoveMembers(p, gid, ['b']) // drops to 1 → dissolve
    expect(p.groups.length).toBe(0)
  })
  it('rename: sets label, clears on null, errors when missing', () => {
    const p = withLayers(['a', 'b'])
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyGroupsRename(p, gid, 'Scene 1'); expect(p.groups[0].label).toBe('Scene 1')
    applyGroupsRename(p, gid, null); expect('label' in p.groups[0]).toBe(false) // null clears the field (serde None parity)
    expectCmd(() => applyGroupsRename(p, 'nope', 'x'), 'GroupNotFound')
  })
})
