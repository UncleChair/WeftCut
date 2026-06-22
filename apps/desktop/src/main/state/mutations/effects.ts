import type { Animated, Effect, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'

/** Mirrors native/src/state/effect.rs:29-33 EffectPatch. Absent/null = "don't
 *  touch"; `params` MERGES key-by-key (insert/overwrite, no deletion). */
export interface EffectPatch {
  enabled?: boolean | null
  params?: Record<string, Animated<number>> | null
}

/** Locate the layer's effect chain or throw LayerNotFound. */
function effectsOrThrow(p: Project, layerId: Uuid): Effect[] {
  for (const track of p.tracks) {
    const l = track.layers.find((x) => x.id === layerId)
    if (l) return l.effects
  }
  throw new CommandFailure({ error: 'LayerNotFound', layer: layerId })
}

/** mutations.rs:1462 (apply_add_effect) + commands/mutations.rs:460-474. The
 *  effect id is minted UNCONDITIONALLY, BEFORE the layer lookup — so a
 *  LayerNotFound still burns the id. This is the OPPOSITE of applyAddLayer
 *  (add.ts:33, mints after the track check). Mints here, not in the dispatch
 *  arm, so the actor's commit pipeline stays uniform. */
export function applyAddEffect(p: Project, idGen: IdGen, layerId: Uuid, kind: string): Uuid {
  const id = idGen() // unconditional — burned even on LayerNotFound
  const effect: Effect = { id, kind, enabled: true, params: {} }
  effectsOrThrow(p, layerId).push(effect)
  return id
}

/** mutations.rs:1482 — replace `enabled` when present; merge `params`
 *  key-by-key when present. LayerNotFound → EffectNotFound. */
export function applyUpdateEffect(p: Project, layerId: Uuid, effectId: Uuid, patch: EffectPatch): void {
  const e = effectsOrThrow(p, layerId).find((x) => x.id === effectId)
  if (!e) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  if (typeof patch.enabled === 'boolean') e.enabled = patch.enabled
  if (patch.params && typeof patch.params === 'object') {
    for (const [k, v] of Object.entries(patch.params)) e.params[k] = v
  }
}

/** mutations.rs:1513 — reorder within the chain (0 = first). Rejection order:
 *  LayerNotFound → EffectNotFound → EffectIndexOutOfRange (>= len). */
export function applyMoveEffect(p: Project, layerId: Uuid, effectId: Uuid, newIndex: number): void {
  const effects = effectsOrThrow(p, layerId)
  const from = effects.findIndex((e) => e.id === effectId)
  if (from < 0) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  const len = effects.length
  if (newIndex >= len) throw new CommandFailure({ error: 'EffectIndexOutOfRange', index: newIndex, len })
  const [e] = effects.splice(from, 1)
  effects.splice(newIndex, 0, e)
}

/** mutations.rs:1541 — remove by id. LayerNotFound → EffectNotFound. */
export function applyRemoveEffect(p: Project, layerId: Uuid, effectId: Uuid): void {
  const effects = effectsOrThrow(p, layerId)
  const at = effects.findIndex((e) => e.id === effectId)
  if (at < 0) throw new CommandFailure({ error: 'EffectNotFound', effect: effectId })
  effects.splice(at, 1)
}
