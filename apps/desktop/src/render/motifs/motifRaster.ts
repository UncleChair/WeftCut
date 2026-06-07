// apps/desktop/src/render/motifs/motifRaster.ts
// The live per-frame producer for Motifs: captures one frame through the
// webcap CDP path. Drop-in replacement for the SVG `rasterTemplateFrame`,
// same perf instrument so existing e2e render-count assertions keep working.
import { captureMotifFrame } from "./host";

export async function rasterMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  if (typeof window !== "undefined") {
    const perf = (window as unknown as { __weftcutTemplatePerf?: { renders: number } })
      .__weftcutTemplatePerf;
    if (perf) perf.renders++;
  }
  return captureMotifFrame(motifId, tSec, props, width, height);
}
