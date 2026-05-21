// Content-hash-keyed cache of rasterized template bitmaps.
//
// One process-wide singleton (`sharedTemplateRasterCache`) is consumed by
// every `TemplateSprite`. Two sprites referencing the same template with
// the same canonical props at the same composition dims share one
// `ImageBitmap` — useful for templates the user has duplicated across
// layers (e.g., a corner logo bug on every clip). Keys are produced by
// `rasterCacheKey` in Rasterizer.ts; they include the template version
// so prop / template-asset edits invalidate naturally (a new key, not a
// mutation of an existing one).
//
// Sprite dispose does NOT clear cached bitmaps — the next sprite asking
// for the same key wants to skip the rasterize. Bitmaps live until the
// Compositor / process tears down, or until `clearSharedTemplateRasterCache`
// is called (dev / test only). Memory footprint is bounded by the
// distinct (template, version, props, w, h) combos in a session; in
// practice this is small. If the cap matters later, add LRU eviction
// in this file without touching call sites.

export class TemplateRasterCache {
  private map = new Map<string, ImageBitmap>();

  get(key: string): ImageBitmap | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, bitmap: ImageBitmap): void {
    const prev = this.map.get(key);
    if (prev && prev !== bitmap) prev.close();
    this.map.set(key, bitmap);
  }

  /// Drop a specific entry (rarely needed — version-bumped keys
  /// naturally produce fresh entries).
  invalidate(key: string): void {
    const prev = this.map.get(key);
    if (prev) {
      prev.close();
      this.map.delete(key);
    }
  }

  /// Bitmaps currently held, for diagnostics.
  size(): number {
    return this.map.size;
  }

  dispose(): void {
    for (const bm of this.map.values()) bm.close();
    this.map.clear();
  }
}

/// Process-wide cache instance. Every TemplateSprite reads/writes here
/// so identical-input rasters across sprites resolve from one bitmap.
export const sharedTemplateRasterCache = new TemplateRasterCache();

/// Dev / test helper. Production code should never need to flush the
/// shared cache — version-bumped keys make stale entries unreachable
/// rather than incorrect. Tests use this to start from a known state.
export function clearSharedTemplateRasterCache(): void {
  sharedTemplateRasterCache.dispose();
}
