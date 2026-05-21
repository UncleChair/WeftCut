import { afterEach, describe, expect, test, vi } from "vitest";
import {
  TemplateRasterCache,
  clearSharedTemplateRasterCache,
  sharedTemplateRasterCache,
} from "./Cache";

/// Stand-in for the browser `ImageBitmap`. The cache treats values
/// opaquely except for the one `close()` call on eviction. Tests can
/// inspect that.
function fakeBitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  clearSharedTemplateRasterCache();
});

describe("TemplateRasterCache", () => {
  test("get returns null for missing keys", () => {
    const c = new TemplateRasterCache();
    expect(c.get("x")).toBeNull();
  });

  test("set + get returns the stored bitmap", () => {
    const c = new TemplateRasterCache();
    const bm = fakeBitmap();
    c.set("k", bm);
    expect(c.get("k")).toBe(bm);
    expect(c.size()).toBe(1);
  });

  test("set on an existing key replaces and closes the prior bitmap", () => {
    const c = new TemplateRasterCache();
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.set("k", a);
    c.set("k", b);
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(c.get("k")).toBe(b);
  });

  test("set with the same bitmap reference does not double-close", () => {
    const c = new TemplateRasterCache();
    const a = fakeBitmap();
    c.set("k", a);
    c.set("k", a);
    expect(a.close).not.toHaveBeenCalled();
  });

  test("invalidate closes + removes the entry", () => {
    const c = new TemplateRasterCache();
    const a = fakeBitmap();
    c.set("k", a);
    c.invalidate("k");
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(c.get("k")).toBeNull();
    expect(c.size()).toBe(0);
  });

  test("dispose closes every cached bitmap", () => {
    const c = new TemplateRasterCache();
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.set("k1", a);
    c.set("k2", b);
    c.dispose();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(c.size()).toBe(0);
  });
});

describe("sharedTemplateRasterCache", () => {
  test("two sprites resolving the same key share one bitmap", () => {
    // Simulate sprite A rasterizing first, then sprite B reading
    // the cached entry without rasterizing again.
    const bm = fakeBitmap();
    sharedTemplateRasterCache.set("shared-key", bm);
    const observed = sharedTemplateRasterCache.get("shared-key");
    expect(observed).toBe(bm);
    expect(bm.close).not.toHaveBeenCalled();
  });

  test("clearSharedTemplateRasterCache drops every entry", () => {
    const bm = fakeBitmap();
    sharedTemplateRasterCache.set("k", bm);
    expect(sharedTemplateRasterCache.size()).toBe(1);
    clearSharedTemplateRasterCache();
    expect(sharedTemplateRasterCache.size()).toBe(0);
    expect(bm.close).toHaveBeenCalledTimes(1);
  });
});
