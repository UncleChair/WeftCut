// apps/desktop/src/main/state/mutations/split.ts
import type { Animated, Keyframe, Layer, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { snapFrameRound } from '../snap'
import { CommandFailure } from '../errors'
import { locateLayer } from './helpers'
import { groupSiblingsExcluding, checkGroupLock, indexGroups } from './groups'
import { forEachAnimatedF64, forEachAnimatedRgba, retainKeyframes, shiftKeyframes, firstKeyframeValue, lastKeyframeValue, collapseToStatic } from './animated'

/** mutations.rs:797-811 — partition one Animated<T> track for a split at the
 *  clip-local `splitOffset`. LEFT keeps t<=offset; RIGHT keeps t>offset, rebased
 *  by -offset. An emptied Keyframed half collapses to Static at the boundary value
 *  (LEFT→first, RIGHT→last). */
function splitTrackHalf<T>(a: Animated<T>, splitOffset: number, right: boolean): void {
  const boundary = right ? lastKeyframeValue(a) : firstKeyframeValue(a)
  if (right) { retainKeyframes(a, (t) => t > splitOffset); shiftKeyframes(a, -splitOffset) }
  else { retainKeyframes(a, (t) => t <= splitOffset) }
  if (a.mode === 'Keyframed' && (a.value as Keyframe<T>[]).length === 0 && boundary !== null) collapseToStatic(a, boundary)
}

/** mutations.rs:815-874 — single-layer split (group-unaware). Returns {left,right};
 *  left reuses the original id, right gets a fresh one and is inserted at li+1. */
function splitSingleLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number): { left: Uuid; right: Uuid } {
  const atTUs = snapFrameRound(atTUsRaw, p.composition.fps.num, p.composition.fps.den)
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  const original = p.tracks[ti].layers[li]
  if (atTUs <= original.t_start_us || atTUs >= original.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })
  const splitOffset = atTUs - original.t_start_us

  // RIGHT half — fresh id, [atTUs, original.t_end].
  const right = JSON.parse(JSON.stringify(original)) as Layer // Immer-draft-safe deep clone (see duplicate.ts)
  right.id = idGen()
  right.t_start_us = atTUs
  right.t_end_us = original.t_end_us
  // Phase 2a: no Motif cap in the corpus; capped===false. Phase 2b: real motif cap.
  const rightCapped = false
  if (right.params.kind === 'VideoClip' || right.params.kind === 'Audio') right.params.src_in_us += splitOffset
  else if (right.params.kind === 'Motif' && rightCapped) right.params.src_in_us += splitOffset
  forEachAnimatedF64(right.params, (a) => splitTrackHalf(a, splitOffset, true))
  forEachAnimatedRgba(right.params, (a) => splitTrackHalf(a, splitOffset, true))

  // LEFT half — reuses original id, [original.t_start, atTUs].
  const left = JSON.parse(JSON.stringify(original)) as Layer
  left.t_end_us = atTUs
  if (left.params.kind === 'VideoClip' || left.params.kind === 'Audio') left.params.src_out_us = left.params.src_in_us + splitOffset
  forEachAnimatedF64(left.params, (a) => splitTrackHalf(a, splitOffset, false))
  forEachAnimatedRgba(left.params, (a) => splitTrackHalf(a, splitOffset, false))

  p.tracks[ti].layers[li] = left
  p.tracks[ti].layers.splice(li + 1, 0, right)
  return { left: id, right: right.id }
}

/** mutations.rs:714-789 — split with group spanning fan-out. */
export function applySplitLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, escapeGroup: boolean): { left: Uuid; right: Uuid } {
  const atTUs = snapFrameRound(atTUsRaw, p.composition.fps.num, p.composition.fps.den)
  // Pre-flight on the target.
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  if (p.tracks[ti].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[ti].id })
  const tgt = p.tracks[ti].layers[li]
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

  // Split each spanning sibling in sorted order; add its right-half to the sibling's group.
  for (const sid of spanning) {
    const { right: rightId } = splitSingleLayer(p, idGen, sid, atTUs)
    const gid = indexGroups(p.groups).get(sid)
    if (gid !== undefined) {
      const g = p.groups.find((x) => x.id === gid)
      if (g) { g.members = [...g.members, rightId].sort() }
    }
  }
  // Add the target's right-half to its group, if any. UNCONDITIONAL (mutations.rs:779-787):
  // even with escape_group, the target's left half keeps the original id and stays grouped,
  // so its right half joins too (verified against the group-split-escape oracle: 3 members).
  const tgid = indexGroups(p.groups).get(targetHalves.left)
  if (tgid !== undefined) { const g = p.groups.find((x) => x.id === tgid); if (g) { g.members = [...g.members, targetHalves.right].sort() } }

  return targetHalves
}
