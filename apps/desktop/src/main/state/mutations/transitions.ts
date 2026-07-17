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

/** add_transition. Both layers must live on the SAME track.
 *  Three cases: adjacent (extend from), pre-overlapped by exactly duration
 *  (no-op), or reject TransitionLayersNotAdjacent. The transition id is minted
 *  AFTER those checks (so LayerNotFound/TransitionLayersNotAdjacent burn no id)
 *  but BEFORE commit's validate — so a downstream ValidationFailed burns it
 *  (the keystone landmine; gated by add-transition-validate-fail-burns-id). */
export function applyAddTransition(p: Project, idGen: IdGen, fromLayer: Uuid, toLayer: Uuid, durationUs: number, kind: Transition['kind']): Uuid {
  const fromLoc = locate(p, fromLayer)
  if (!fromLoc) throw new CommandFailure({ error: 'LayerNotFound', layer: fromLayer })
  const [trackIdx, fromIdx] = fromLoc
  const toIdx = p.tracks[trackIdx].layers.findIndex((l) => l.id === toLayer)
  if (toIdx < 0) throw new CommandFailure({ error: 'LayerNotFound', layer: toLayer })

  const fromLayerObj = p.tracks[trackIdx].layers[fromIdx]
  const fromEnd = fromLayerObj.t_end_us
  const toStart = p.tracks[trackIdx].layers[toIdx].t_start_us
  const curOverlap = Math.max(fromEnd - toStart, 0)
  if (curOverlap === 0 && fromEnd === toStart) extendLayerTEnd(fromLayerObj, durationUs)
  else if (curOverlap === durationUs) { /* pre-positioned; no adjustment */ }
  else throw new CommandFailure({ error: 'TransitionLayersNotAdjacent', from: fromLayer, to: toLayer, duration: durationUs })

  const id = idGen() // after the checks, before commit's validate (keystone)
  p.transitions.push({ id, from_layer: fromLayer, to_layer: toLayer, duration_us: durationUs, kind })
  return id
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
