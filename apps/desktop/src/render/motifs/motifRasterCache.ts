// Shared raster primitive: process-wide cache singleton and the one-frame
// render helper used by both the on-demand TemplateSprite path and the
// background prewarmer.
//
// Why a separate module: the prewarmer and the sprite MUST share one
// `MotifFrameCache` instance (the prewarmer fills the cache the sprite reads).
// Pulling the cache + raster function here lets both importers reach the same
// objects without coupling them to each other's class.

import { MotifFrameCache } from "./frameCache";
import { BakedKeyIndex } from "./bakedKeyIndex";
import type { Motif } from "./catalog";
import { rasterMotifFrame } from "./motifRaster";

/// Process-wide per-frame cache shared by every TemplateSprite AND the
/// prewarmer, so identical (template, props, dims, fps, frame) rasters resolve
/// from one bitmap. Single instance — import this, never `new`.
export const sharedMotifFrameCache = new MotifFrameCache();

/// Process-wide index of which cacheKeys have frames baked on disk. The
/// Compositor hydrates it on project load; the baker `add`s on each write.
export const sharedBakedKeyIndex = new BakedKeyIndex();

/// Obtain one template frame, preferring a pre-baked PNG on disk over a live
/// raster. Read-only: writing is the MotifBaker's job (single writer →
/// no LRU-eviction race on a fire-and-forget encode). Shared by the on-demand
/// sprite path and the prewarmer, so disk-first is uniform.
///
/// Disk read is attempted only when `sharedBakedKeyIndex.has(cacheKey)` — so an
/// un-baked template never pays an IPC. Any read/permission error is swallowed
/// and falls through to a live raster, so an fs hiccup can never blank preview.
export async function resolveMotifFrame(
  template: Motif,
  cacheKey: string,
  frame: number,
  tSec: number,
  durationSec: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  if (sharedBakedKeyIndex.has(cacheKey)) {
    try {
      const png = await sharedMotifFrameCache.readPng(cacheKey, frame);
      if (png) return await createImageBitmap(png);
    } catch {
      // permission/io hiccup — fall through to live raster.
    }
  }
  const [w, h] = template.manifest.size;
  // durationSec is unused by the CDP path (duration is derived Rust-side from
  // props in v1); kept in the signature for parity with the SVG era.
  void durationSec;
  return rasterMotifFrame(template.manifest.id, tSec, canonicalProps, w!, h!, template.manifest.settle_rafs);
}
