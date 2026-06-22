import type { Project, Uuid, Layer } from '../model'
import type { IdGen } from '../ids'
import { applyDurationAutofit, locateLayer } from './helpers'
import { CommandFailure } from '../errors'

/** actor.rs:2885-2927 — shallow-clone the layer with one fresh id (nested
 *  keyframe/effect ids are NOT regenerated), offset by tOffsetUs, insert
 *  t-start-sorted on the same track, autofit. Duplicate does NOT join a group. */
export function applyDuplicateLayer(p: Project, idGen: IdGen, id: Uuid, tOffsetUs: number): Uuid {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  // JSON round-trip instead of structuredClone for Immer draft safety:
  // inside an Immer produce() recipe, p.tracks[ti].layers[li] is a draft Proxy.
  // structuredClone() throws DataCloneError on a Proxy; JSON.parse(JSON.stringify())
  // reads through the proxy and is safe. Our model is JSON-native (no undefined/Map/Set),
  // so the round-trip is lossless.
  const copy = JSON.parse(JSON.stringify(p.tracks[ti].layers[li])) as Layer
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
