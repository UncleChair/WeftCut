import { current, isDraft } from 'immer'
import type { Layer, LayerParams, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { frameGrid, snapUpOnGrid } from '../snap'
import { forEachAnimatedF64, forEachAnimatedRgba, shiftKeyframes } from './animated'

/** Deep-clone a layer whether it came from an Immer recipe or plain test data. */
export function cloneLayer(layer: Layer): Layer {
  return structuredClone(isDraft(layer) ? current(layer) : layer)
}

export function locateLayer(p: Project, id: Uuid): [number, number] | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const li = p.tracks[ti].layers.findIndex((l) => l.id === id)
    if (li >= 0) return [ti, li]
  }
  return null
}

/** Reconcile composition.duration_us with the layer high-water mark (ADR 0005).
 *
 *  The high-water mark is rounded UP to the enclosing composition frame, which
 *  matters only once audio lives on the 48 kHz lattice (spec R2-D6): an audio
 *  `t_end_us` is a sample boundary and at 29.97 / 59.94 that is generally NOT a
 *  frame boundary, so copying it verbatim would put `duration_us` off the frame grid
 *  and validate would reject the edit that caused it (`OffGridTime`). Up, not
 *  nearest: content ending mid-frame occupies that frame, and rounding down would
 *  make the composition shorter than its own content. Identity for frame-aligned
 *  content, which is every visual layer and all audio at the six rates where the
 *  frame lattice is an exact sublattice of the sample lattice. */
export function applyDurationAutofit(p: Project): void {
  let maxEnd = 0
  for (const t of p.tracks) for (const l of t.layers) if (l.t_end_us > maxEnd) maxEnd = l.t_end_us
  const grid = frameGrid(p.composition.fps)
  const fitted = maxEnd > 0 ? snapUpOnGrid(maxEnd, grid) : 0
  if (p.composition.duration_pinned) { if (fitted > p.composition.duration_us) p.composition.duration_us = fitted }
  else p.composition.duration_us = fitted
}

/** A track disappears when its last layer leaves it (ADR 0042). The one prune,
 *  called by every path that can empty a track, with the track the caller just
 *  emptied — never a project-wide sweep, so a track that was *born* empty was
 *  never emptied and survives, and no edit can make a track vanish elsewhere.
 *
 *  `transient` reads as "not part of the reserved skeleton": it is stamped on
 *  every role-less track at creation, so it is the cleanup-candidate flag rather
 *  than the narrower import-spawned marker its name suggests. `!locked` because
 *  locking is the user pinning a row, and cleanup does not out-rank that.
 *
 *  Returns the removed track id, so a caller can report what went with the edit. */
export function pruneEmptiedTrack(p: Project, trackId: Uuid): Uuid | null {
  const idx = p.tracks.findIndex((t) => t.id === trackId)
  if (idx < 0) return null
  const t = p.tracks[idx]
  if (t.layers.length !== 0 || !t.transient || t.locked) return null
  p.tracks.splice(idx, 1)
  return trackId
}

/** Remove a layer from every group; auto-dissolve below 2. */
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

/** Locked-track guard; missing layer → LayerNotFound. */
export function checkTrackLock(p: Project, id: Uuid): void {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const track = p.tracks[loc[0]]
  if (track.locked) throw new CommandFailure({ error: 'TrackLocked', track: track.id })
}

/** Shift every animated track's keyframes by deltaUs (trim IN glues keyframes to
 *  content). */
export function shiftLayerKeyframes(params: LayerParams, deltaUs: number): void {
  forEachAnimatedF64(params, (a) => shiftKeyframes(a, deltaUs))
  forEachAnimatedRgba(params, (a) => shiftKeyframes(a, deltaUs))
}
