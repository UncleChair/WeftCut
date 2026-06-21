// Resolves a layer's effect chain to the ordered Pixi filter list for a
// single frame. A thin adapter so Compositor does not need to call
// EffectChain.sync directly, and so this logic is unit-testable without
// pulling in the full Compositor import graph.
//
// Preview LOD gating lives here: pass opts.previewEffectsEnabled=false to
// skip all filters (scrub perf). Future resolution-based tiers can also go
// here before delegating to chain.sync.

import type { Filter } from "pixi.js";
import type { LayerSummary } from "../../ipc";
import type { EffectChain } from "./EffectChain";

/** Resolve a layer's effect chain to the ordered Pixi filters for this frame.
 *
 * Pass `opts.previewEffectsEnabled = false` to skip all filters during
 * scrub/preview (LOD gate). The export worker calls chain.sync directly
 * and is always full-quality — this opt never reaches that path.
 */
export function effectsFor(
  chain: EffectChain,
  layer: LayerSummary,
  tInLayerUs: number,
  opts?: { previewEffectsEnabled?: boolean },
): Filter[] {
  if (opts?.previewEffectsEnabled === false) return [];
  return chain.sync(layer.effects ?? [], tInLayerUs);
}
