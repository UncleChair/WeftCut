import { describe, expect, test, vi } from "vitest";
import { TemplateFrameCache, hashCacheKey, type Closeable } from "./frameCache";

/// Stand-in for the browser `ImageBitmap`. The L0 store treats values
/// opaquely except for the `close()` call on eviction / clear / dispose,
/// so a `{ close: vi.fn() }` is enough to assert the close behavior.
/// (Mirrors `fakeBitmap()` in Cache.test.ts.)
function fakeBitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

describe("TemplateFrameCache — L0 LRU", () => {
  test("getFrame returns null on miss", () => {
    const c = new TemplateFrameCache();
    expect(c.getFrame("k", 0)).toBeNull();
  });

  test("setFrame + getFrame returns the stored bitmap", () => {
    const c = new TemplateFrameCache();
    const bm = fakeBitmap();
    c.setFrame("k", 3, bm);
    expect(c.getFrame("k", 3)).toBe(bm);
    expect(c.size()).toBe(1);
  });

  test("frames are keyed by (cacheKey, frameIndex)", () => {
    const c = new TemplateFrameCache();
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k", 0, a);
    c.setFrame("k", 1, b);
    expect(c.getFrame("k", 0)).toBe(a);
    expect(c.getFrame("k", 1)).toBe(b);
    expect(c.size()).toBe(2);
  });

  test("re-set of an existing entry closes the prior bitmap + refreshes recency", () => {
    const c = new TemplateFrameCache(3);
    const a = fakeBitmap();
    const a2 = fakeBitmap();
    c.setFrame("k", 0, a);
    c.setFrame("k", 0, a2);
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(c.getFrame("k", 0)).toBe(a2);
    expect(c.size()).toBe(1);
  });

  test("re-set with the same bitmap reference does not close it", () => {
    const c = new TemplateFrameCache();
    const a = fakeBitmap();
    c.setFrame("k", 0, a);
    c.setFrame("k", 0, a);
    expect(a.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBe(a);
  });

  test("capacity eviction closes the least-recently-used frame", () => {
    const c = new TemplateFrameCache(2);
    const a = fakeBitmap();
    const b = fakeBitmap();
    const d = fakeBitmap();
    c.setFrame("k", 0, a); // [a]
    c.setFrame("k", 1, b); // [a, b]
    c.setFrame("k", 2, d); // overflow → evict a → [b, d]
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBeNull();
    expect(c.getFrame("k", 1)).toBe(b);
    expect(c.getFrame("k", 2)).toBe(d);
    expect(c.size()).toBe(2);
  });

  test("getFrame refreshes recency so the touched frame survives eviction", () => {
    const c = new TemplateFrameCache(2);
    const a = fakeBitmap();
    const b = fakeBitmap();
    const d = fakeBitmap();
    c.setFrame("k", 0, a); // [a]
    c.setFrame("k", 1, b); // [a, b]
    // Touch a → it becomes MRU; b is now LRU.
    expect(c.getFrame("k", 0)).toBe(a); // [b, a]
    c.setFrame("k", 2, d); // overflow → evict b → [a, d]
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(a.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBe(a);
    expect(c.getFrame("k", 1)).toBeNull();
    expect(c.getFrame("k", 2)).toBe(d);
  });

  test("setFrame refreshes recency so a re-set frame survives eviction", () => {
    // Re-`setFrame` of an existing entry must move it to the MRU tail (same as
    // a get-hit), so the OTHER frame becomes the LRU eviction victim.
    const c = new TemplateFrameCache(2);
    const a = fakeBitmap();
    const a2 = fakeBitmap();
    const b = fakeBitmap();
    const d = fakeBitmap();
    c.setFrame("k", 0, a); // [k#0]
    c.setFrame("k", 1, b); // [k#0, k#1]
    // Re-set k#0 with a new bitmap → k#0 becomes MRU; k#1 is now LRU.
    c.setFrame("k", 0, a2); // [k#1, k#0]; closes the prior k#0 bitmap (a)
    expect(a.close).toHaveBeenCalledTimes(1);
    c.setFrame("k", 2, d); // overflow → evict LRU (k#1) → [k#0, k#2]
    expect(b.close).toHaveBeenCalledTimes(1); // k#1 evicted
    expect(a2.close).not.toHaveBeenCalled(); // re-set k#0 survived
    expect(d.close).not.toHaveBeenCalled();
    expect(c.getFrame("k", 0)).toBe(a2);
    expect(c.getFrame("k", 1)).toBeNull();
    expect(c.getFrame("k", 2)).toBe(d);
  });

  test("rejects a negative or fractional frameIndex at the boundary", () => {
    const c = new TemplateFrameCache();
    const a = fakeBitmap();
    expect(() => c.setFrame("k", -1, a)).toThrow(/non-negative integer/);
    expect(() => c.setFrame("k", 1.5, a)).toThrow(/non-negative integer/);
    expect(() => c.getFrame("k", -1)).toThrow(/non-negative integer/);
  });

  test("a NaN cap falls back to the default bound (eviction still fires)", () => {
    // A NaN cap previously disabled eviction entirely (`size > NaN` is always
    // false). It must clamp to the default (240) instead of growing unbounded.
    const c = new TemplateFrameCache(Number.NaN);
    for (let i = 0; i < 241; i++) c.setFrame("k", i, fakeBitmap());
    expect(c.size()).toBe(240);
  });

  test("hasKey reflects presence of any frame for a key", () => {
    const c = new TemplateFrameCache();
    expect(c.hasKey("k")).toBe(false);
    c.setFrame("k", 0, fakeBitmap());
    expect(c.hasKey("k")).toBe(true);
    expect(c.hasKey("other")).toBe(false);
  });

  test("clearKey closes only that key's frames", () => {
    const c = new TemplateFrameCache();
    const a0 = fakeBitmap();
    const a1 = fakeBitmap();
    const b0 = fakeBitmap();
    c.setFrame("a", 0, a0);
    c.setFrame("a", 1, a1);
    c.setFrame("b", 0, b0);
    c.clearKey("a");
    expect(a0.close).toHaveBeenCalledTimes(1);
    expect(a1.close).toHaveBeenCalledTimes(1);
    expect(b0.close).not.toHaveBeenCalled();
    expect(c.hasKey("a")).toBe(false);
    expect(c.getFrame("b", 0)).toBe(b0);
    expect(c.size()).toBe(1);
  });

  test("prefix-collision: a cacheKey that is a textual prefix of another is not swept", () => {
    // cacheKeys are caller-built JSON and can contain '#'. Key "a" must
    // not match "a#b"'s frame "a#b#5" (the '#'-split must anchor on the
    // LAST '#' and require an all-digit frame-index suffix).
    const c = new TemplateFrameCache();
    const shortKey = fakeBitmap();
    const longKey = fakeBitmap();
    c.setFrame("a", 5, shortKey); // map key "a#5"
    c.setFrame("a#b", 5, longKey); // map key "a#b#5"
    expect(c.hasKey("a")).toBe(true);
    expect(c.hasKey("a#b")).toBe(true);

    c.clearKey("a"); // must drop ONLY "a#5"
    expect(shortKey.close).toHaveBeenCalledTimes(1);
    expect(longKey.close).not.toHaveBeenCalled();
    expect(c.hasKey("a")).toBe(false);
    expect(c.hasKey("a#b")).toBe(true);
    expect(c.getFrame("a#b", 5)).toBe(longKey);
  });

  test("dispose closes every frame across all keys", () => {
    const c = new TemplateFrameCache();
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k1", 0, a);
    c.setFrame("k2", 0, b);
    c.dispose();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(c.size()).toBe(0);
  });

  test("default cap is a sensible bound (240)", () => {
    const c = new TemplateFrameCache();
    for (let i = 0; i < 240; i++) c.setFrame("k", i, fakeBitmap());
    expect(c.size()).toBe(240);
    c.setFrame("k", 240, fakeBitmap()); // overflow by one
    expect(c.size()).toBe(240);
    expect(c.getFrame("k", 0)).toBeNull(); // oldest evicted
  });

  test("constructor clamps a non-positive cap to at least 1", () => {
    const c = new TemplateFrameCache(0);
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.setFrame("k", 0, a);
    c.setFrame("k", 1, b); // a evicted
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(c.size()).toBe(1);
  });
});

describe("hashCacheKey", () => {
  test("is deterministic and 8-char lowercase hex", () => {
    const h = hashCacheKey("template|3|640|360|{\"x\":1}");
    expect(h).toBe(hashCacheKey("template|3|640|360|{\"x\":1}"));
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  test("distinct keys hash to distinct dir names (no trivial collision)", () => {
    expect(hashCacheKey("a")).not.toBe(hashCacheKey("b"));
    expect(hashCacheKey("template|1")).not.toBe(hashCacheKey("template|2"));
  });
});

// The `Closeable` interface is re-exported for callers; this no-op
// reference keeps the import meaningful to the type checker.
const _typecheck: Closeable = { close: () => {} };
void _typecheck;
