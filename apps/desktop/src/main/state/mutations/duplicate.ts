import type { Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { applyDurationAutofit, cloneLayer, locateLayer } from './helpers'
import { CommandFailure } from '../errors'

/** actor.rs:2885-2927 — shallow-clone the layer with one fresh id (nested
 *  keyframe/effect ids are NOT regenerated), offset by tOffsetUs, insert
 *  t-start-sorted on the same track, autofit. Duplicate does NOT join a group. */
export function applyDuplicateLayer(p: Project, idGen: IdGen, id: Uuid, tOffsetUs: number): Uuid {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  const copy = cloneLayer(p.tracks[ti].layers[li])
  const dupId = idGen()
  copy.id = dupId
  copy.t_start_us += tOffsetUs
  copy.t_end_us += tOffsetUs
  const track = p.tracks[ti]
  const at = track.layers.findIndex((l) => l.t_start_us > copy.t_start_us)
  track.layers.splice(at < 0 ? track.layers.length : at, 0, copy)
  applyDurationAutofit(p)
  return dupId
}
