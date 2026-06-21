// Resolves a layer's effect chain to the ordered Pixi filter list for a
// single frame. A thin adapter so Compositor does not need to call
// EffectChain.sync directly, and so this logic is unit-testable without
// pulling in the full Compositor import graph.
//
// Preview LOD options (Task 12) will live here — e.g. skipping expensive
// effects below a resolution threshold before delegating to chain.sync.

import type { Filter } from "pixi.js";
import type { LayerSummary } from "../../ipc";
import type { EffectChain } from "./EffectChain";

/** Resolve a layer's effect chain to the ordered Pixi filters for this frame. */
export function effectsFor(
  chain: EffectChain,
  layer: LayerSummary,
  tInLayerUs: number,
): Filter[] {
  return chain.sync(layer.effects ?? [], tInLayerUs);
}
