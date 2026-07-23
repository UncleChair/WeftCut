import type { Layer, Project, Transition, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'

/** Extend t_end_us (and src_out_us for media-bearing kinds)
 *  by deltaUs. Used by add_transition to open the authorized overlap. */
export function extendLayerTEnd(layer: Layer, deltaUs: number): void {
  layer.t_end_us += deltaUs
  if (layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio') layer.params.src_out_us += deltaUs
}

/** Inverse of extendLayerTEnd; saturates at 0. Used by
 *  remove_transition to undo the auto-extension. */
export function shrinkLayerTEnd(layer: Layer, deltaUs: number): void {
  layer.t_end_us = Math.max(layer.t_end_us - deltaUs, 0)
  if (layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio') layer.params.src_out_us = Math.max(layer.params.src_out_us - deltaUs, 0)
}

/** Locate a layer's (trackIdx, layerIdx) or null. */
function locate(p: Project, id: Uuid): [number, number] | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const li = p.tracks[ti].layers.findIndex((l) => l.id === id)
    if (li >= 0) return [ti, li]
  }
  return null
}

/** Tail handle: source media remaining past src_out_us, in µs. Free-duration
 *  kinds (Image/Text/Motif/Color) are unlimited. A null/undefined (or missing-
 *  media) duration means unknowable → unlimited too, mirroring how the
 *  SrcRangeExceedsMedia validation only fires when duration is non-null. */
function tailHandleUs(p: Project, layer: Layer): number {
  const pa = layer.params
  if (pa.kind !== 'VideoClip' && pa.kind !== 'Audio') return Infinity
  const dur = p.media_pool[pa.media]?.metadata.duration_us
  if (dur === null || dur === undefined) return Infinity
  return Math.max(dur - pa.src_out_us, 0)
}

/** Audio participants are rejected here (precise, pre-id-mint error); validate's
 *  TransitionUnsupportedLayerKind rule is the backstop no path can bypass. */
function rejectAudioParticipant(layer: Layer): void {
  if (layer.params.kind === 'Audio')
    throw new CommandFailure({ error: 'TransitionUnsupportedLayerKind', layer: layer.id, kind: layer.params.kind })
}

/** add_transition. Both layers must live on the SAME track.
 *  Three cases: adjacent (extend from — pre-checked against the outgoing tail
 *  handle), pre-overlapped by exactly duration (no extension, so no handle
 *  pre-check), or reject TransitionLayersNotAdjacent. The transition id is
 *  minted AFTER all checks (so LayerNotFound/TransitionUnsupportedLayerKind/
 *  TransitionInsufficientHandle/TransitionLayersNotAdjacent burn no id) but
 *  BEFORE commit's validate — so a downstream ValidationFailed burns it
 *  (the keystone landmine; gated by add-transition-validate-fail-burns-id). */
export function applyAddTransition(p: Project, idGen: IdGen, fromLayer: Uuid, toLayer: Uuid, durationUs: number, kind: Transition['kind']): Uuid {
  const fromLoc = locate(p, fromLayer)
  if (!fromLoc) throw new CommandFailure({ error: 'LayerNotFound', layer: fromLayer })
  const [trackIdx, fromIdx] = fromLoc
  const toIdx = p.tracks[trackIdx].layers.findIndex((l) => l.id === toLayer)
  if (toIdx < 0) throw new CommandFailure({ error: 'LayerNotFound', layer: toLayer })

  const fromLayerObj = p.tracks[trackIdx].layers[fromIdx]
  const toLayerObj = p.tracks[trackIdx].layers[toIdx]
  rejectAudioParticipant(fromLayerObj)
  rejectAudioParticipant(toLayerObj)

  const fromEnd = fromLayerObj.t_end_us
  const toStart = toLayerObj.t_start_us
  const curOverlap = Math.max(fromEnd - toStart, 0)
  if (curOverlap === 0 && fromEnd === toStart) {
    const available = tailHandleUs(p, fromLayerObj)
    if (available < durationUs)
      throw new CommandFailure({ error: 'TransitionInsufficientHandle', layer: fromLayer, available_us: available })
    extendLayerTEnd(fromLayerObj, durationUs)
  }
  else if (curOverlap === durationUs) { /* pre-positioned; no adjustment */ }
  else throw new CommandFailure({ error: 'TransitionLayersNotAdjacent', from: fromLayer, to: toLayer, duration: durationUs })

  const id = idGen() // after the checks, before commit's validate (keystone)
  p.transitions.push({ id, from_layer: fromLayer, to_layer: toLayer, duration_us: durationUs, kind })
  return id
}

/** update_transition — patch { duration_us?, kind? } on one transition
 *  (direction rides inside kind). Duration deltas move the OUTGOING layer's
 *  tail via extend/shrinkLayerTEnd (start-at-cut alignment: only from_layer's
 *  geometry changes); growth gets the same tail-handle pre-check as add.
 *  Kind change is a pure field swap, never geometry. Patch semantics so the
 *  actor exposes it as ONE recorded command (one undo step). Mints no ids. */
export function applyUpdateTransition(p: Project, transitionId: Uuid, patch: { duration_us?: number; kind?: Transition['kind'] }): void {
  const tr = p.transitions.find((t) => t.id === transitionId)
  if (!tr) throw new CommandFailure({ error: 'TransitionNotFound', transition: transitionId })
  const newDur = patch.duration_us
  if (newDur !== undefined && newDur !== tr.duration_us) {
    if (newDur <= 0)
      throw new CommandFailure({ error: 'ValidationFailed', detail: { rule: 'TransitionDurationOutOfRange', transition: transitionId, duration: newDur } })
    const loc = locate(p, tr.from_layer)
    if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: tr.from_layer })
    const fromLayerObj = p.tracks[loc[0]].layers[loc[1]]
    const delta = newDur - tr.duration_us
    if (delta > 0) {
      const available = tailHandleUs(p, fromLayerObj)
      if (available < delta)
        throw new CommandFailure({ error: 'TransitionInsufficientHandle', layer: tr.from_layer, available_us: available })
      extendLayerTEnd(fromLayerObj, delta)
    } else shrinkLayerTEnd(fromLayerObj, -delta)
    tr.duration_us = newDur
  }
  if (patch.kind !== undefined) tr.kind = patch.kind
}

/** remove_transition — remove by id, then shrink from_layer back by duration
 *  (if it still exists) to restore a validation-passing shape. */
export function applyRemoveTransition(p: Project, transitionId: Uuid): void {
  const idx = p.transitions.findIndex((t) => t.id === transitionId)
  if (idx < 0) throw new CommandFailure({ error: 'TransitionNotFound', transition: transitionId })
  const tr = p.transitions[idx]
  p.transitions.splice(idx, 1)
  const loc = locate(p, tr.from_layer)
  if (loc) shrinkLayerTEnd(p.tracks[loc[0]].layers[loc[1]], tr.duration_us)
}
