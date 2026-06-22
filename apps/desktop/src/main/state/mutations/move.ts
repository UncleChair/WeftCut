// apps/desktop/src/main/state/mutations/move.ts
import type { Layer, Project, Uuid } from '../model'
import { snapFrameRound } from '../snap'
import { applyDurationAutofit, locateLayer, pruneEmptyHiddenTracks } from './helpers'
import { CommandFailure } from '../errors'

/** All other members of `id`'s group (empty when ungrouped). Phase 1 never
 *  creates groups, so this is always []; the fan-out below is dead code kept
 *  for the Phase-2 wiring (mutations.rs:661-669). */
function groupSiblingsExcluding(p: Project, id: Uuid): Uuid[] {
  for (const g of p.groups) if (g.members.includes(id)) return g.members.filter((m) => m !== id)
  return []
}

/** Port of mutations.rs:502-635. */
export function applyMoveLayer(p: Project, id: Uuid, newTrackId: Uuid, newTStartUs: number, escapeGroup: boolean): void {
  const fpsN = p.composition.fps.num, fpsD = p.composition.fps.den
  const snapped = snapFrameRound(newTStartUs, fpsN, fpsD)
  const src = locateLayer(p, id)
  if (!src) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [srcTi] = src
  const curStart = p.tracks[srcTi].layers[src[1]].t_start_us
  if (p.tracks[srcTi].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[srcTi].id })
  if (newTrackId !== p.tracks[srcTi].id) {
    const dst = p.tracks.find((t) => t.id === newTrackId)
    if (dst && dst.locked) throw new CommandFailure({ error: 'TrackLocked', track: newTrackId })
  }
  const delta = snapped - curStart

  const siblings = escapeGroup ? [] : groupSiblingsExcluding(p, id)
  // (group lock check omitted in P1: siblings always empty; ported in Phase 2)

  // Remove the target layer.
  let moved: Layer | undefined
  for (const track of p.tracks) {
    const idx = track.layers.findIndex((l) => l.id === id)
    if (idx >= 0) { moved = track.layers.splice(idx, 1)[0]; break }
  }
  const layer = moved! // existence verified above
  layer.t_start_us = snapped
  // Re-snap t_end to the grid (alternating 33_333/33_334µs frame widths at 30fps).
  layer.t_end_us = snapFrameRound(layer.t_end_us + delta, fpsN, fpsD)
  const destIdx = p.tracks.findIndex((t) => t.id === newTrackId)
  if (destIdx < 0) throw new CommandFailure({ error: 'TrackNotFound', track: newTrackId })
  const dest = p.tracks[destIdx]
  const at = dest.layers.findIndex((l) => l.t_start_us > snapped)
  dest.layers.splice(at < 0 ? dest.layers.length : at, 0, layer)

  // Group siblings follow + shift by the same delta (dead in Phase 1).
  if (!escapeGroup) {
    for (const sid of siblings) {
      const loc = locateLayer(p, sid)
      if (!loc) continue
      const s = p.tracks[loc[0]].layers.splice(loc[1], 1)[0]
      if (delta !== 0) {
        s.t_start_us = snapFrameRound(s.t_start_us + delta, fpsN, fpsD)
        s.t_end_us = snapFrameRound(s.t_end_us + delta, fpsN, fpsD)
      }
      s.t_start_us = Math.max(s.t_start_us, 0)
      const di = p.tracks.findIndex((t) => t.id === newTrackId)
      const sAt = p.tracks[di].layers.findIndex((l) => l.t_start_us > s.t_start_us)
      p.tracks[di].layers.splice(sAt < 0 ? p.tracks[di].layers.length : sAt, 0, s)
    }
  }

  applyDurationAutofit(p)
  pruneEmptyHiddenTracks(p)
}
