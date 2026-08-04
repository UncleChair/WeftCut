import type { Animated, Interpolation, Keyframe, Layer, Project, Transform, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { checkTrackLock, locateLayer } from './helpers'

/** The transform of a layer whose kind carries one, else null (Color/Audio). */
export function transformOf(layer: Layer): Transform | null {
  const p = layer.params
  return p.kind === 'Color' || p.kind === 'Audio' ? null : p.transform
}

function interpEq(a: Interpolation, b: Interpolation): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind !== 'Bezier' || b.kind !== 'Bezier') return true
  return a.p1[0] === b.p1[0] && a.p1[1] === b.p1[1] && a.p2[0] === b.p2[0] && a.p2[1] === b.p2[1]
}

/** Structural twin test for the two scale tracks. Keyframe `id`s are per-track
 *  identities and legitimately differ between twins, so they are IGNORED here —
 *  comparing them would misread every honest twin pair as diverged (and the
 *  load-time backfill in serialize.ts would then unlink every layer it loads).
 *  Defensive against wire shapes: a malformed entry compares as diverged rather
 *  than throwing, because the backfill runs before validate gets to reject. */
export function scaleTracksTwins(a: Animated<number>, b: Animated<number>): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (a.mode !== b.mode) return false
  if (a.mode === 'Static') return a.value === (b as { value: number }).value
  const ka = a.value
  const kb = (b as { value: Keyframe<number>[] }).value
  if (!Array.isArray(ka) || !Array.isArray(kb) || ka.length !== kb.length) return false
  return ka.every((k, i) => {
    const o = kb[i]
    return k !== null && o !== null && typeof k === 'object' && typeof o === 'object'
      && k.t_us === o.t_us && k.value === o.value && interpEq(k.interp, o.interp)
  })
}

/** Structural copy of a scale track for the OTHER axis: fresh keyframe ids
 *  (per-track identities — see scaleTracksTwins), no shared mutable state
 *  (Bezier handle arrays are re-created, not aliased). The renderer's
 *  fan-out twin (keyframe/fanOut.ts twinTrackCopy) is the same shape with
 *  crypto ids — a change here usually needs the same change there. */
export function copyTrackFreshIds(track: Animated<number>, idGen: IdGen): Animated<number> {
  if (track.mode === 'Static') return { mode: 'Static', value: track.value }
  return {
    mode: 'Keyframed',
    value: track.value.map((k) => ({ id: idGen(), t_us: k.t_us, value: k.value, interp: cloneInterp(k.interp) })),
  }
}

function cloneInterp(i: Interpolation): Interpolation {
  return i.kind === 'Bezier' ? { kind: 'Bezier', p1: [i.p1[0], i.p1[1]], p2: [i.p2[0], i.p2[1]] } : { kind: i.kind }
}

/** The scale-link invariant: `scale_linked = true` ⇒ the two tracks are twins.
 *  Checked on RESULTS, not write paths — run it after any mutation that can
 *  touch a scale track and it self-heals by clearing the flag in the SAME
 *  commit. A write that leaves the tracks equal (e.g. one patch setting both
 *  axes to the same value) therefore never unlinks; only genuine divergence
 *  does. Runs at commit granularity, NOT per batch entry: a linked fan-out
 *  batch is mid-divergence between its scale_x and scale_y entries. */
export function enforceScaleLinkInvariant(p: Project, id: Uuid): void {
  const loc = locateLayer(p, id)
  if (!loc) return
  const t = transformOf(p.tracks[loc[0]].layers[loc[1]])
  if (!t || t.scale_linked !== true) return
  if (!scaleTracksTwins(t.scale_x, t.scale_y)) t.scale_linked = false
}

/** set_scale_linked (mutation half). Linking is the design's one destructive
 *  moment: `scale_y` becomes a fresh-id copy of `scale_x`, whole track,
 *  keyframes included — even a Keyframed Y under a Static X is overwritten
 *  (single rule, no special cases; undo is the safety net). Unlinking touches
 *  only the flag, so the tracks stay twins until the first divergent edit. */
export function applySetScaleLinked(p: Project, idGen: IdGen, id: Uuid, linked: boolean): void {
  checkTrackLock(p, id) // LayerNotFound / TrackLocked
  const loc = locateLayer(p, id)! // existence guaranteed by checkTrackLock
  const layer = p.tracks[loc[0]].layers[loc[1]]
  const t = transformOf(layer)
  if (!t) throw new CommandFailure({ error: 'UnknownKeyframeParam', layer: id, param_key: 'scale_linked' })
  if (linked) t.scale_y = copyTrackFreshIds(t.scale_x, idGen)
  t.scale_linked = linked
}
