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

/** Every layer id across all tracks. */
export function layerIdSet(p: Project): Set<Uuid> {
  const s = new Set<Uuid>()
  for (const t of p.tracks) for (const l of t.layers) s.add(l.id)
  return s
}

/** All OTHER members of `id`'s group, in sorted member
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

/** Reject if any `touched` member is layer-locked or on a
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

// ── Write-side group mutations ────────────────────────────────────────────────

import type { IdGen } from '../ids'
import { dropLayerFromGroups } from './helpers'

function sortedUnique(ids: Uuid[]): Uuid[] { return [...new Set(ids)].sort() }

/** Create a new group from the given layer ids.
 *  Dedup → existence → already-grouped → reassign-drops → id alloc → push.
 *  `label === null` → field omitted (serde None parity: `'label' in group === false`). */
export function applyGroupsCreate(p: Project, idGen: IdGen, layerIds: Uuid[], label: string | null, reassign: boolean): Uuid {
  const unique = sortedUnique(layerIds)
  if (unique.length < 2) throw new CommandFailure({ error: 'GroupCreateNeedsTwoLayers', got: unique.length })
  const known = layerIdSet(p)
  for (const m of unique) if (!known.has(m)) throw new CommandFailure({ error: 'LayerNotFound', layer: m })
  const idx = indexGroups(p.groups)
  for (const m of unique) {
    const existing = idx.get(m)
    if (existing !== undefined && !reassign) throw new CommandFailure({ error: 'LayerAlreadyGrouped', layer: m, existing })
  }
  if (reassign) for (const m of unique) dropLayerFromGroups(p, m)
  const id = idGen()
  const group: Group = label === null ? { id, members: unique } : { id, label, members: unique }
  p.groups.push(group)
  return id
}

export function applyGroupsDissolve(p: Project, id: Uuid): void {
  const i = p.groups.findIndex((g) => g.id === id)
  if (i < 0) throw new CommandFailure({ error: 'GroupNotFound', group: id })
  p.groups.splice(i, 1)
}

/** Add members to an existing group.
 *  layer-existence → already-grouped scan → reassign-drops → GroupNotFound → insert sorted.
 *  Order matches Rust exactly: already-grouped check runs before the target-group lookup. */
export function applyGroupsAddMembers(p: Project, id: Uuid, layerIds: Uuid[], reassign: boolean): void {
  // Scan the RAW input (Rust iterates layer_ids unmodified — first error follows input order).
  const known = layerIdSet(p)
  for (const m of layerIds) if (!known.has(m)) throw new CommandFailure({ error: 'LayerNotFound', layer: m })
  const idx = indexGroups(p.groups)
  for (const m of layerIds) {
    const existing = idx.get(m)
    if (existing !== undefined && existing !== id && !reassign) throw new CommandFailure({ error: 'LayerAlreadyGrouped', layer: m, existing })
  }
  if (reassign) for (const m of layerIds) { if (idx.get(m) !== id) dropLayerFromGroups(p, m) }
  // GroupNotFound is checked AFTER the scans.
  const target = p.groups.find((g) => g.id === id)
  if (!target) throw new CommandFailure({ error: 'GroupNotFound', group: id })
  // Final member set is an OrdSet: dedup + sort (mirrors group.members.insert).
  target.members = [...new Set([...target.members, ...layerIds])].sort()
}

/** Remove members; auto-dissolve below 2. */
export function applyGroupsRemoveMembers(p: Project, id: Uuid, layerIds: Uuid[]): void {
  const i = p.groups.findIndex((g) => g.id === id)
  if (i < 0) throw new CommandFailure({ error: 'GroupNotFound', group: id })
  const g = p.groups[i]
  const members = new Set(g.members)
  for (const m of layerIds) if (!members.has(m)) throw new CommandFailure({ error: 'LayerNotInGroup', group: id, layer: m })
  const removals = new Set(layerIds)
  g.members = g.members.filter((m) => !removals.has(m))
  if (g.members.length < 2) p.groups.splice(i, 1)
}

/** Rename a group; null → delete label field (serde None parity). */
export function applyGroupsRename(p: Project, id: Uuid, label: string | null): void {
  const g = p.groups.find((x) => x.id === id)
  if (!g) throw new CommandFailure({ error: 'GroupNotFound', group: id })
  if (label === null) delete g.label
  else g.label = label
}
