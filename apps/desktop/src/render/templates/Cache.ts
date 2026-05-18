// Content-hash-keyed cache of rasterized template bitmaps.
//
// Plan: docs/pixi-renderer-plan.md (P5)
//
// P0 stub. P5 implements blake3-of-(template_id || canonical_json(props)
// || font_set_hash || w || h) → ImageBitmap.

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

  /// Drop a specific entry (called when a template's prop changes).
  invalidate(key: string): void {
    const prev = this.map.get(key);
    if (prev) {
      prev.close();
      this.map.delete(key);
    }
  }

  dispose(): void {
    for (const bm of this.map.values()) bm.close();
    this.map.clear();
  }
}
