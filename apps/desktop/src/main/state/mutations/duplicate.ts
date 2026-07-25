import type { Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { applyDurationAutofit, cloneLayer, locateLayer } from './helpers'
import { CommandFailure } from '../errors'
import { snapFrameRound } from '../snap'

/** Shallow-clone the layer with one fresh id (nested keyframe/effect ids are
 *  NOT regenerated), offset by tOffsetUs, insert t-start-sorted on the same
 *  track, autofit. Duplicate does NOT join a group.
 *
 *  `tOffsetUs` arrives raw from `duplicate_layer` (MCP-only — no UI caller), so
 *  offsetting both edges by it directly takes them off the frame grid at every
 *  rational rate. It goes through `pasteLayerInterval` instead: ONE shift model
 *  for duplicate and paste, snapped start with the end carried by the resulting
 *  delta, so the copy keeps the source's frame span. */
export function applyDuplicateLayer(p: Project, idGen: IdGen, id: Uuid, tOffsetUs: number): Uuid {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  const source = p.tracks[ti].layers[li]
  const interval = pasteLayerInterval(p, id, source.t_start_us + tOffsetUs)
  const copy = cloneLayer(source)
  const dupId = idGen()
  copy.id = dupId
  copy.t_start_us = interval.tStartUs
  copy.t_end_us = interval.tEndUs
  const track = p.tracks[ti]
  const at = track.layers.findIndex((l) => l.t_start_us > copy.t_start_us)
  track.layers.splice(at < 0 ? track.layers.length : at, 0, copy)
  applyDurationAutofit(p)
  return dupId
}

export interface PasteLayerInterval {
  tStartUs: number
  tEndUs: number
}

/** Resolve the exact frame-snapped interval used when a copied layer is pasted.
 *  The source layer's duration is shifted the same way as a normal move, which
 *  preserves its frame span on fractional frame-rate grids. */
export function pasteLayerInterval(p: Project, id: Uuid, tStartUs: number): PasteLayerInterval {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const source = p.tracks[loc[0]].layers[loc[1]]
  const snappedStart = snapFrameRound(tStartUs, p.composition.fps.num, p.composition.fps.den)
  const delta = snappedStart - source.t_start_us
  return {
    tStartUs: snappedStart,
    tEndUs: snapFrameRound(source.t_end_us + delta, p.composition.fps.num, p.composition.fps.den),
  }
}

/** Paste a detached clone onto an explicitly resolved target track. The caller
 *  owns automatic track selection/creation; this mutation preserves all layer
 *  content and effects, gives only the layer a fresh id, and never joins the
 *  source group. */
export function applyPasteLayer(
  p: Project,
  idGen: IdGen,
  sourceId: Uuid,
  targetTrackId: Uuid,
  tStartUs: number,
): Uuid {
  const sourceLoc = locateLayer(p, sourceId)
  if (!sourceLoc) throw new CommandFailure({ error: 'LayerNotFound', layer: sourceId })
  const target = p.tracks.find((track) => track.id === targetTrackId)
  if (!target) throw new CommandFailure({ error: 'TrackNotFound', track: targetTrackId })

  const interval = pasteLayerInterval(p, sourceId, tStartUs)
  const copy = cloneLayer(p.tracks[sourceLoc[0]].layers[sourceLoc[1]])
  const pastedId = idGen()
  copy.id = pastedId
  copy.t_start_us = interval.tStartUs
  copy.t_end_us = interval.tEndUs

  const at = target.layers.findIndex((layer) => layer.t_start_us > interval.tStartUs)
  target.layers.splice(at < 0 ? target.layers.length : at, 0, copy)
  applyDurationAutofit(p)
  return pastedId
}
