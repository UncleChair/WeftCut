// src/main/state/mutations/composition.ts
import type { Project } from '../model'
import { applyDurationAutofit } from './helpers'

/** Unpin, then refit duration to the layer high-water mark. Recorded (the
 *  actor commits this). Inverse of an explicit set_composition{duration_us}. */
export function applyFitComposition(p: Project): void {
  p.composition.duration_pinned = false
  applyDurationAutofit(p)
}
