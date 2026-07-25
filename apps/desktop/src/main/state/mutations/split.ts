// apps/desktop/src/main/state/mutations/split.ts
import type { Animated, Keyframe, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { CommandFailure } from '../errors'
import { cloneLayer, locateLayer } from './helpers'
import { groupSiblingsExcluding, checkGroupLock, indexGroups } from './groups'
import { forEachAnimatedF64, forEachAnimatedRgba, retainKeyframes, shiftKeyframes, firstKeyframeValue, lastKeyframeValue, collapseToStatic } from './animated'

/** Partition one Animated<T> track for a split at the
 *  clip-local `splitOffset`. LEFT keeps t<=offset; RIGHT keeps t>offset, rebased
 *  by -offset. An emptied Keyframed half collapses to Static at the boundary value
 *  (LEFT→first, RIGHT→last). */
function splitTrackHalf<T>(a: Animated<T>, splitOffset: number, right: boolean): void {
  const boundary = right ? lastKeyframeValue(a) : firstKeyframeValue(a)
  if (right) { retainKeyframes(a, (t) => t > splitOffset); shiftKeyframes(a, -splitOffset) }
  else { retainKeyframes(a, (t) => t <= splitOffset) }
  if (a.mode === 'Keyframed' && (a.value as Keyframe<T>[]).length === 0 && boundary !== null) collapseToStatic(a, boundary)
}

/** Single-layer split (group-unaware). Returns {left,right};
 *  left reuses the original id, right gets a fresh one and is inserted at li+1. */
function splitSingleLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number): { left: Uuid; right: Uuid } {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  const original = p.tracks[ti].layers[li]
  // The cut resolves on THIS layer's grid, not the composition's — so a grouped A/V
  // split cuts the audio on the nearest sample boundary while the video cuts on the
  // frame boundary (spec R2-D6). Locate first: the grid depends on `params.kind`.
  const atTUs = snapOnGrid(atTUsRaw, gridForLayerKind(original.params.kind, p.composition.fps))
  if (atTUs <= original.t_start_us || atTUs >= original.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })
  const splitOffset = atTUs - original.t_start_us

  // RIGHT half — fresh id, [atTUs, original.t_end].
  const right = cloneLayer(original)
  right.id = idGen()
  right.t_start_us = atTUs
  right.t_end_us = original.t_end_us
  // No Motif duration cap is implemented; capped===false for Motif layers.
  const rightCapped = false
  if (right.params.kind === 'VideoClip' || right.params.kind === 'Audio') right.params.src_in_us += splitOffset
  else if (right.params.kind === 'Motif' && rightCapped) right.params.src_in_us += splitOffset
  forEachAnimatedF64(right.params, (a) => splitTrackHalf(a, splitOffset, true))
  forEachAnimatedRgba(right.params, (a) => splitTrackHalf(a, splitOffset, true))

  // LEFT half — reuses original id, [original.t_start, atTUs].
  const left = cloneLayer(original)
  left.t_end_us = atTUs
  if (left.params.kind === 'VideoClip' || left.params.kind === 'Audio') left.params.src_out_us = left.params.src_in_us + splitOffset
  forEachAnimatedF64(left.params, (a) => splitTrackHalf(a, splitOffset, false))
  forEachAnimatedRgba(left.params, (a) => splitTrackHalf(a, splitOffset, false))

  p.tracks[ti].layers[li] = left
  p.tracks[ti].layers.splice(li + 1, 0, right)
  return { left: id, right: right.id }
}

/** Split with group spanning fan-out. */
export function applySplitLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, escapeGroup: boolean): { left: Uuid; right: Uuid } {
  // Pre-flight on the target.
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  if (p.tracks[ti].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[ti].id })
  const tgt = p.tracks[ti].layers[li]
  // Snapped on the TARGET's grid for the pre-flight + containment tests; each
  // spanning sibling then re-snaps `atTUs` on its own grid inside splitSingleLayer.
  const atTUs = snapOnGrid(atTUsRaw, gridForLayerKind(tgt.params.kind, p.composition.fps))
  if (atTUs <= tgt.t_start_us || atTUs >= tgt.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })

  // Spanning siblings: members whose interval strictly contains atTUs (sorted order).
  // groupSiblingsExcluding returns SORTED members — id-allocation order matches Rust OrdSet.
  const spanning: Uuid[] = escapeGroup ? [] : groupSiblingsExcluding(p, id).filter((s) => {
    const sl = locateLayer(p, s); if (!sl) return false
    const l = p.tracks[sl[0]].layers[sl[1]]
    return l.t_start_us < atTUs && atTUs < l.t_end_us
  })
  if (!escapeGroup) checkGroupLock(p, id, [id, ...spanning])

  // Split target FIRST (id-allocation order: target right-half id comes first).
  const targetHalves = splitSingleLayer(p, idGen, id, atTUs)
  const groupByMember = indexGroups(p.groups)
  const groupById = new Map(p.groups.map((g) => [g.id, g]))

  // Split each spanning sibling in sorted order; add its right-half to the sibling's group.
  for (const sid of spanning) {
    const { right: rightId } = splitSingleLayer(p, idGen, sid, atTUs)
    const gid = groupByMember.get(sid)
    if (gid !== undefined) {
      const g = groupById.get(gid)
      if (g) { g.members = [...g.members, rightId].sort() }
    }
  }
  // Add the target's right-half to its group, if any. UNCONDITIONAL:
  // even with escape_group, the target's left half keeps the original id and stays grouped,
  // so its right half joins too (verified against the group-split-escape oracle: 3 members).
  const tgid = groupByMember.get(targetHalves.left)
  if (tgid !== undefined) { const g = groupById.get(tgid); if (g) { g.members = [...g.members, targetHalves.right].sort() } }

  return targetHalves
}
