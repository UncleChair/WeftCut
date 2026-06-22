// src/main/state/mutations/update.ts
import type { Project, Uuid } from '../model'
import { checkTrackLock, locateLayer } from './helpers'

/** Mirrors native/src/state/actor.rs:79-90 LayerPatch. null/absent = "don't touch". */
export interface LayerPatch {
  label?: string | null
  t_start_us?: number | null
  t_end_us?: number | null
  enabled?: boolean | null
  locked?: boolean | null
}

/** mutations.rs:332-362 — envelope-only patch. check_track_lock FIRST (rejects
 *  edits on a locked track / missing layer), then apply only the provided fields.
 *  Does NOT autofit (Rust doesn't — a t_end edit here never moves composition.duration_us). */
export function applyUpdateLayer(p: Project, id: Uuid, patch: LayerPatch): void {
  checkTrackLock(p, id) // throws LayerNotFound (missing) or TrackLocked (locked track)
  const loc = locateLayer(p, id)! // existence guaranteed by checkTrackLock
  const layer = p.tracks[loc[0]].layers[loc[1]]
  if (typeof patch.label === 'string') layer.label = patch.label
  if (typeof patch.t_start_us === 'number') layer.t_start_us = patch.t_start_us
  if (typeof patch.t_end_us === 'number') layer.t_end_us = patch.t_end_us
  if (typeof patch.enabled === 'boolean') layer.enabled = patch.enabled
  if (typeof patch.locked === 'boolean') layer.locked = patch.locked
}
