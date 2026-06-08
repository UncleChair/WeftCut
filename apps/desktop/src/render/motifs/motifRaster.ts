// apps/desktop/src/render/motifs/motifRaster.ts
// The live per-frame producer for Motifs: captures one frame through the
// webcap CDP path, bumping the same perf instrument so existing e2e
// render-count assertions keep working.
import { captureMotifFrame } from "./host";
import type { Motif } from "./catalog";

export async function rasterMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
): Promise<ImageBitmap> {
  if (typeof window !== "undefined") {
    const perf = (window as unknown as { __weftcutMotifPerf?: { renders: number } })
      .__weftcutMotifPerf;
    if (perf) perf.renders++;
  }
  return captureMotifFrame(motifId, tSec, props, width, height, settleRafs);
}

/// Capture one ARBITRARY content frame of a Motif directly via CDP, at the
/// motif's manifest size. The baker is the sole L2 writer and already gates on
/// `isOnDisk`, so it must NOT read disk-first (that's `resolveMotifFrame`'s
/// job for the read paths) — it always captures. `tSec = frame * fpsDen/fpsNum`.
export function bakeMotifFrame(
  template: Motif,
  frame: number,
  fpsNum: number,
  fpsDen: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  const [w, h] = template.manifest.size;
  return rasterMotifFrame(template.manifest.id, (frame * fpsDen) / fpsNum, canonicalProps, w!, h!, template.manifest.settle_rafs);
}
