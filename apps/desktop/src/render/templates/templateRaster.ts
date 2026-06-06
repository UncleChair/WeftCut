// Shared raster primitive: process-wide cache singleton, per-templateId harness
// map, and the one-frame render helper used by both the on-demand TemplateSprite
// path and the background prewarmer.
//
// Why a separate module: the prewarmer and the sprite MUST share one
// `TemplateFrameCache` instance (the prewarmer fills the cache the sprite reads).
// Pulling the cache + harness map + raster function here lets both importers
// reach the same objects without coupling them to each other's class.

import { TemplateFrameCache } from "./frameCache";
import { BakedKeyIndex } from "./bakedKeyIndex";
import { TemplateHarness } from "./harness";
import { rasterizeSvg } from "./svgRaster";
import type { Template } from "./catalog";

/// Process-wide per-frame cache shared by every TemplateSprite AND the
/// prewarmer, so identical (template, props, dims, fps, frame) rasters resolve
/// from one bitmap. Single instance — import this, never `new`.
export const sharedTemplateFrameCache = new TemplateFrameCache();

/// Process-wide index of which cacheKeys have frames baked on disk. The
/// Compositor hydrates it on project load; the baker `add`s on each write.
export const sharedBakedKeyIndex = new BakedKeyIndex();

interface HarnessEntry {
  harness: TemplateHarness;
  ready: Promise<void>;
}
const harnessByTemplateId = new Map<string, HarnessEntry>();

/// Get (or lazily mount) the shared harness for `template`. Touches the DOM
/// (iframe + listener) — main thread only, never the export Worker.
///
/// NOTE: many DISTINCT templates on screen at once would each hold their own
/// iframe; a real fix would be a bounded harness pool keyed by recency. v1
/// doesn't need it (the built-in catalog is one entry).
export function harnessFor(template: Template): HarnessEntry {
  let entry = harnessByTemplateId.get(template.manifest.id);
  if (!entry) {
    const harness = new TemplateHarness();
    entry = { harness, ready: harness.load(template) };
    harnessByTemplateId.set(template.manifest.id, entry);
  }
  return entry;
}

/// Render one template frame to an ImageBitmap via the shared harness. Shared
/// by the on-demand sprite path and the prewarmer. Does NOT touch the cache —
/// callers `setFrame` the result (idempotent).
export async function rasterTemplateFrame(
  template: Template,
  tSec: number,
  durationSec: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  const entry = harnessFor(template);
  await entry.ready;
  const svg = await entry.harness.renderFrameSvg(tSec, durationSec, canonicalProps);
  return rasterizeSvg(svg);
}

/// Obtain one template frame, preferring a pre-baked PNG on disk over a live
/// raster. Read-only: writing is the TemplateBaker's job (single writer →
/// no LRU-eviction race on a fire-and-forget encode). Shared by the on-demand
/// sprite path and the prewarmer, so disk-first is uniform.
///
/// Disk read is attempted only when `sharedBakedKeyIndex.has(cacheKey)` — so an
/// un-baked template never pays an IPC. Any read/permission error is swallowed
/// and falls through to a live raster, so an fs hiccup can never blank preview.
export async function resolveTemplateFrame(
  template: Template,
  cacheKey: string,
  frame: number,
  tSec: number,
  durationSec: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  if (sharedBakedKeyIndex.has(cacheKey)) {
    try {
      const png = await sharedTemplateFrameCache.readPng(cacheKey, frame);
      if (png) return await createImageBitmap(png);
    } catch {
      // permission/io hiccup — fall through to live raster.
    }
  }
  return rasterTemplateFrame(template, tSec, durationSec, canonicalProps);
}
