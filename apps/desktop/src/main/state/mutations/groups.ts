// apps/desktop/src/main/state/mutations/groups.ts
import type { Group, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { locateLayer } from './helpers'

/** group.rs:index_groups — member LayerId → owning GroupId. */
export function indexGroups(groups: Group[]): Map<Uuid, Uuid> {
  const m = new Map<Uuid, Uuid>()
  for (const g of groups) for (const member of g.members) m.set(member, g.id)
  return m
}

/** mutations.rs:321-329 — every layer id across all tracks. */
export function layerIdSet(p: Project): Set<Uuid> {
  const s = new Set<Uuid>()
  for (const t of p.tracks) for (const l of t.layers) s.add(l.id)
  return s
}

/** mutations.rs:661-670 — all OTHER members of `id`'s group, in sorted member
 *  order (Rust OrdSet iteration order). Empty when ungrouped. The sort is the
 *  id-allocation-order guarantee for split fan-out (see plan Global Constraints). */
export function groupSiblingsExcluding(p: Project, id: Uuid): Uuid[] {
  const idx = indexGroups(p.groups)
  const gid = idx.get(id)
  if (gid === undefined) return []
  const group = p.groups.find((g) => g.id === gid)
  if (!group) return []
  return [...group.members].filter((m) => m !== id).sort()
}

/** mutations.rs:677-704 — reject if any `touched` member is layer-locked or on a
 *  locked track. No-op when `anchor` is ungrouped. */
export function checkGroupLock(p: Project, anchor: Uuid, touched: Iterable<Uuid>): void {
  const idx = indexGroups(p.groups)
  const gid = idx.get(anchor)
  if (gid === undefined) return
  for (const id of touched) {
    const loc = locateLayer(p, id)
    if (!loc) continue
    const track = p.tracks[loc[0]]
    if (track.locked) throw new CommandFailure({ error: 'TrackLocked', track: track.id })
    const layer = track.layers[loc[1]]
    if (layer.locked) throw new CommandFailure({ error: 'GroupLockedMember', group: gid, locked_layer: id, touched: anchor })
  }
}
