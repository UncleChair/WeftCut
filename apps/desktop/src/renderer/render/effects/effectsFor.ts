// Resolves a layer's effect chain to the ordered Pixi filter list for a
// single frame. A thin adapter so Compositor does not need to call
// EffectChain.sync directly, and so this logic is unit-testable without
// pulling in the full Compositor import graph.

import type { Filter } from "pixi.js";
import type { LayerSummary } from "../../ipc";
import type { EffectChain } from "./EffectChain";

/** Resolve a layer's effect chain to the ordered Pixi filters for this frame.
 *
 * Pass `opts.previewEffectsEnabled = false` to skip all filters during
 * scrub/preview (LOD gate). Compositor pins it true in export mode, so the
 * gate is inert on the export path — export is always full-quality.
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
