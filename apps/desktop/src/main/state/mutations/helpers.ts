import type { LayerParams, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { forEachAnimatedF64, forEachAnimatedRgba, shiftKeyframes } from './animated'

/** mutations.rs:651-658 */
export function locateLayer(p: Project, id: Uuid): [number, number] | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const li = p.tracks[ti].layers.findIndex((l) => l.id === id)
    if (li >= 0) return [ti, li]
  }
  return null
}

/** mutations.rs:28-42 — reconcile composition.duration_us with the layer high-water mark. */
export function applyDurationAutofit(p: Project): void {
  let maxEnd = 0
  for (const t of p.tracks) for (const l of t.layers) if (l.t_end_us > maxEnd) maxEnd = l.t_end_us
  if (p.composition.duration_pinned) { if (maxEnd > p.composition.duration_us) p.composition.duration_us = maxEnd }
  else p.composition.duration_us = maxEnd
}

/** mutations.rs:645-647 — drop empty transient (import-spawned) tracks. */
export function pruneEmptyHiddenTracks(p: Project): void {
  p.tracks = p.tracks.filter((t) => !(t.transient && t.layers.length === 0))
}

/** mutations.rs:144-155 — auto-delete the just-emptied track if eligible. */
export function pruneEmptiedTrack(p: Project, trackId: Uuid): Uuid | null {
  if (!p.settings.auto_delete_empty_tracks) return null
  const idx = p.tracks.findIndex((t) => t.id === trackId)
  if (idx < 0) return null
  const t = p.tracks[idx]
  if (t.layers.length !== 0 || !t.removable || t.role !== null || t.locked) return null
  p.tracks.splice(idx, 1)
  return trackId
}

/** mutations.rs:160-173 — remove a layer from every group; auto-dissolve below 2. */
export function dropLayerFromGroups(p: Project, layerId: Uuid): void {
  let i = 0
  while (i < p.groups.length) {
    const g = p.groups[i]
    if (g.members.includes(layerId)) {
      g.members = g.members.filter((m) => m !== layerId)
      if (g.members.length < 2) { p.groups.splice(i, 1); continue }
    }
    i++
  }
}

/** mutations.rs:97-104 — locked-track guard; missing layer → LayerNotFound. */
export function checkTrackLock(p: Project, id: Uuid): void {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const track = p.tracks[loc[0]]
  if (track.locked) throw new CommandFailure({ error: 'TrackLocked', track: track.id })
}

/** Shift every animated track's keyframes by deltaUs (trim IN glues keyframes to
 *  content). All-Static in the Phase-2a corpus, so this is a no-op there; written
 *  for fidelity with mutations.rs. */
export function shiftLayerKeyframes(params: LayerParams, deltaUs: number): void {
  forEachAnimatedF64(params, (a) => shiftKeyframes(a, deltaUs))
  forEachAnimatedRgba(params, (a) => shiftKeyframes(a, deltaUs))
}
