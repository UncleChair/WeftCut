import type { Project, Uuid } from '../model'
import { CommandFailure } from '../errors'

/** Remove a track. TrackNotFound → TrackNotRemovable (reserved tracks) →
 *  TrackNotEmpty (unless force) → splice. */
export function applyDeleteTrack(p: Project, id: Uuid, force: boolean): void {
  const idx = p.tracks.findIndex((t) => t.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'TrackNotFound', track: id })
  if (!p.tracks[idx].removable) throw new CommandFailure({ error: 'TrackNotRemovable', track: id })
  if (!force && p.tracks[idx].layers.length > 0) throw new CommandFailure({ error: 'TrackNotEmpty', track: id })
  p.tracks.splice(idx, 1)
}

/** Reposition a track. TrackNotFound → TrackPositionOutOfRange →
 *  remove+reinsert. The cur===new no-op (skip commit) is handled by the actor. */
export function applyMoveTrack(p: Project, id: Uuid, newPosition: number): void {
  const cur = p.tracks.findIndex((t) => t.id === id)
  if (cur < 0) throw new CommandFailure({ error: 'TrackNotFound', track: id })
  if (newPosition >= p.tracks.length) throw new CommandFailure({ error: 'TrackPositionOutOfRange', position: newPosition, len: p.tracks.length })
  const [t] = p.tracks.splice(cur, 1)
  p.tracks.splice(newPosition, 0, t)
}
