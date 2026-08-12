// apps/desktop/src/main/state/mutations/move.ts
import type { Layer, Project, Uuid } from '../model'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { applyDurationAutofit, locateLayer, pruneEmptiedTrack } from './helpers'
import { groupSiblingsExcluding, checkGroupLock } from './groups'
import { CommandFailure } from '../errors'

/** Earliest `t_start_us` across the whole moving set (target + group siblings) —
 *  the member that decides where the set stops when it is dragged toward zero.
 *  Read BEFORE the target is spliced out, so `targetStart` is passed in rather than
 *  re-located. A sibling that cannot be located is skipped, matching the move loop's
 *  own tolerance for a stale member id. */
function earliestStart(p: Project, targetStart: number, siblings: readonly Uuid[]): number {
  let earliest = targetStart
  for (const sid of siblings) {
    const loc = locateLayer(p, sid)
    if (!loc) continue
    const s = p.tracks[loc[0]].layers[loc[1]].t_start_us
    if (s < earliest) earliest = s
  }
  return earliest
}

export function applyMoveLayer(p: Project, id: Uuid, newTrackId: Uuid, newTStartUs: number, escapeGroup: boolean): void {
  const fps = p.composition.fps
  const src = locateLayer(p, id)
  if (!src) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [srcTi] = src
  // Read the source track's ID, not its index: the splices below shift indices,
  // and pruning has to name the lane the layer LEFT once the move has settled.
  const srcTrackId = p.tracks[srcTi].id
  const target = p.tracks[srcTi].layers[src[1]]
  // The requested start snaps on the TARGET's own grid — the audio lattice for an
  // Audio layer, the composition frame grid otherwise (spec R2-D6).
  const targetGrid = gridForLayerKind(target.params.kind, fps)
  const snapped = snapOnGrid(newTStartUs, targetGrid)
  const curStart = target.t_start_us
  if (p.tracks[srcTi].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[srcTi].id })
  if (newTrackId !== p.tracks[srcTi].id) {
    const dst = p.tracks.find((t) => t.id === newTrackId)
    if (dst && dst.locked) throw new CommandFailure({ error: 'TrackLocked', track: newTrackId })
  }
  const siblings = escapeGroup ? [] : groupSiblingsExcluding(p, id)
  // Reject up-front if any member (incl. target) is locked / on a locked track.
  // Only fires for a coupled move with real siblings.
  if (!escapeGroup && siblings.length > 0) checkGroupLock(p, id, [id, ...siblings])

  // ── Clamp the DELTA, not each member's start ────────────────────────────────
  // Dragged toward zero, the moving set stops AS A SET: its earliest member lands
  // exactly on 0 and every other member keeps its distance from that member.
  //
  // `NegativeLayerStart` validation is the structural half: a negative start is
  // otherwise perfectly canonical, so the grid backstop alone would wave it through.
  //
  // 0 is a lattice point on every grid, so the earliest member needs no re-snap to
  // stay canonical, and every other member is still `its own start + delta` snapped
  // on its own lattice — which is exactly what keeps a slipped A/V sync offset
  // intact through a whole-group move (R2-D7).
  const delta = Math.max(snapped - curStart, -earliestStart(p, curStart, siblings))
  const newStart = snapOnGrid(curStart + delta, targetGrid)

  // Remove the target layer.
  let moved: Layer | undefined
  for (const track of p.tracks) {
    const idx = track.layers.findIndex((l) => l.id === id)
    if (idx >= 0) { moved = track.layers.splice(idx, 1)[0]; break }
  }
  const layer = moved! // existence verified above
  layer.t_start_us = newStart
  // Re-snap t_end on the same grid (alternating 33_333/33_334µs frame widths at 30fps).
  layer.t_end_us = snapOnGrid(layer.t_end_us + delta, targetGrid)
  const destIdx = p.tracks.findIndex((t) => t.id === newTrackId)
  if (destIdx < 0) throw new CommandFailure({ error: 'TrackNotFound', track: newTrackId })
  const dest = p.tracks[destIdx]
  const at = dest.layers.findIndex((l) => l.t_start_us > newStart)
  dest.layers.splice(at < 0 ? dest.layers.length : at, 0, layer)

  // Group siblings follow + shift by the same delta.
  if (!escapeGroup) {
    for (const sid of siblings) {
      const loc = locateLayer(p, sid)
      if (!loc) continue
      const siblingTrackId = p.tracks[loc[0]].id
      const s = p.tracks[loc[0]].layers.splice(loc[1], 1)[0]
      if (delta !== 0) {
        // LANDMINE: each sibling snaps on ITS OWN grid, not the target's. Snapping a
        // grouped audio member on the composition frame grid here would drag it back
        // to the nearest video frame on any unrelated whole-group move, and the user's
        // deliberately slipped sync offset would silently vanish (spec § Two data-loss
        // dependencies, #1). The offset survives precisely because every member shifts
        // by the same `delta` and then lands on its own lattice — which is also how the
        // implicit sync offset is stored at all (R2-D7: no field, just geometry).
        const g = gridForLayerKind(s.params.kind, fps)
        s.t_start_us = snapOnGrid(s.t_start_us + delta, g)
        s.t_end_us = snapOnGrid(s.t_end_us + delta, g)
      }
      // No per-sibling floor here: `delta` is already clamped so no member can cross
      // 0, and snapping a non-negative time can only return a non-negative lattice
      // point. Re-introducing one would resurrect the shortening defect.
      const di = p.tracks.findIndex((t) => t.id === siblingTrackId)
      const sAt = p.tracks[di].layers.findIndex((l) => l.t_start_us > s.t_start_us)
      p.tracks[di].layers.splice(sAt < 0 ? p.tracks[di].layers.length : sAt, 0, s)
    }
  }

  applyDurationAutofit(p)
  // Cleanup rides in the SAME mutation, so one undo restores the layer's previous
  // position and its track together. Runs last, on settled state: a same-track move
  // has already put the layer back. Only the target changes tracks — every sibling
  // is re-inserted on the one it came from — so this is the only track a move empties.
  pruneEmptiedTrack(p, srcTrackId)
}
