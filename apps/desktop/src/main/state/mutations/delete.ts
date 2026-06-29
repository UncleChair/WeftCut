import type { Project, Uuid } from '../model'
import { applyDurationAutofit, checkTrackLock, dropLayerFromGroups, pruneEmptiedTrack, pruneEmptyHiddenTracks } from './helpers'
import { CommandFailure } from '../errors'

/** Remove the layer, drop from groups (auto-dissolve <2),
 *  prune transient + emptied removable track, autofit. Returns the pruned track id. */
export function applyDeleteLayer(p: Project, id: Uuid): Uuid | null {
  checkTrackLock(p, id) // throws LayerNotFound / TrackLocked
  let sourceTrack: Uuid | null = null
  for (const track of p.tracks) {
    const idx = track.layers.findIndex((l) => l.id === id)
    if (idx >= 0) { track.layers.splice(idx, 1); sourceTrack = track.id; break }
  }
  if (sourceTrack === null) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  dropLayerFromGroups(p, id)
  pruneEmptyHiddenTracks(p)
  const pruned = pruneEmptiedTrack(p, sourceTrack)
  applyDurationAutofit(p)
  return pruned
}
