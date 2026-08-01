// src/main/state/mutations/composition.ts
import type { Project } from '../model'
import { applyDurationAutofit } from './helpers'

/** Unpin, then refit duration to the layer high-water mark. Inverse of an explicit
 *  set_composition{duration_us}, and unrecorded like it: the actor runs this over
 *  every stored snapshot, each refitting to its own high-water mark. */
export function applyFitComposition(p: Project): void {
  p.composition.duration_pinned = false
  applyDurationAutofit(p)
}
