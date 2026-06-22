import type { Animated, Keyframe, LayerParams, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'

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

function shiftAnimated<T>(a: Animated<T>, deltaUs: number): void {
  if (a.mode === 'Keyframed') for (const k of a.value as Keyframe<T>[]) k.t_us += deltaUs
}
/** Shift every animated track's keyframes by deltaUs (trim IN glues keyframes to
 *  content). All-Static in Phase 1, so this is a no-op there; written for fidelity. */
export function shiftLayerKeyframes(params: LayerParams, deltaUs: number): void {
  switch (params.kind) {
    case 'Color': shiftAnimated(params.color, deltaUs); break
    case 'Text':
      shiftAnimated(params.color, deltaUs); shiftAnimated(params.opacity, deltaUs)
      shiftTransform(params.transform, deltaUs); break
    case 'VideoClip': shiftAnimated(params.opacity, deltaUs); shiftTransform(params.transform, deltaUs); break
    case 'ImageOverlay': shiftAnimated(params.opacity, deltaUs); shiftTransform(params.transform, deltaUs); break
    case 'Motif': shiftAnimated(params.opacity, deltaUs); shiftTransform(params.transform, deltaUs); break
    case 'Audio': shiftAnimated(params.gain_db, deltaUs); shiftAnimated(params.pan, deltaUs); break
  }
}
function shiftTransform(t: { x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; rotation_deg: Animated<number> }, d: number): void {
  shiftAnimated(t.x, d); shiftAnimated(t.y, d); shiftAnimated(t.scale_x, d); shiftAnimated(t.scale_y, d); shiftAnimated(t.rotation_deg, d)
}
