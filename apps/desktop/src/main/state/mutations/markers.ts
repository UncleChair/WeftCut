import type { Project, Rgba, Uuid } from '../model'
import { CommandFailure } from '../errors'

/** MarkerPatch. null/absent = "don't touch"; end_t_us can only be SET, never
 *  cleared (clearing → remove+add). */
export interface MarkerPatch {
  t_us?: number | null
  end_t_us?: number | null
  label?: string | null
  color?: Rgba | null
}

/** Patch a marker; only provided fields apply. Re-sorts by t_us (stable) when
 *  t_us changed, preserving the sorted-markers invariant. */
export function applyUpdateMarker(p: Project, id: Uuid, patch: MarkerPatch): void {
  const idx = p.markers.findIndex((m) => m.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'MarkerNotFound', marker: id })
  const needsResort = typeof patch.t_us === 'number'
  const m = p.markers[idx]
  if (typeof patch.t_us === 'number') m.t_us = patch.t_us
  if (typeof patch.end_t_us === 'number') m.end_t_us = patch.end_t_us
  if (typeof patch.label === 'string') m.label = patch.label
  if (patch.color && typeof patch.color === 'object') m.color = patch.color
  if (needsResort) p.markers.sort((a, b) => (a.t_us < b.t_us ? -1 : a.t_us > b.t_us ? 1 : 0))
}

/** Remove a marker by id. */
export function applyRemoveMarker(p: Project, id: Uuid): void {
  const idx = p.markers.findIndex((m) => m.id === id)
  if (idx < 0) throw new CommandFailure({ error: 'MarkerNotFound', marker: id })
  p.markers.splice(idx, 1)
}
