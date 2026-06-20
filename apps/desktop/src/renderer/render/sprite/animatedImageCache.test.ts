import { describe, it, expect, vi } from "vitest";
import {
  createAnimatedImageCache,
  type DecodedAnimation,
  type DecodeFn,
} from "./animatedImageCache";

/// A fake decoded animation whose "bitmaps" record close() calls.
function fakeAnimation(): DecodedAnimation {
  const mk = () => ({ close: vi.fn(), width: 4, height: 4 }) as unknown as ImageBitmap;
  return { frames: [mk(), mk()], durationsUs: [100_000, 100_000], totalUs: 200_000, width: 4, height: 4 };
}

describe("createAnimatedImageCache", () => {
  it("decodes once per key and shares the result (single-flight)", async () => {
    const decode: DecodeFn = vi.fn(async () => fakeAnimation());
    const cache = createAnimatedImageCache(decode);
    const [a, b] = await Promise.all([
      cache.acquire("k", "url", 10, 10),
      cache.acquire("k", "url", 10, 10),
    ]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("closes every frame when the last reference is released", async () => {
    const anim = fakeAnimation();
    const decode: DecodeFn = vi.fn(async () => anim);
    const cache = createAnimatedImageCache(decode);
    await cache.acquire("k", "url", 10, 10);
    await cache.acquire("k", "url", 10, 10); // refs = 2
    cache.release("k"); // refs = 1, not yet closed
    expect(anim.frames[0]!.close).not.toHaveBeenCalled();
    cache.release("k"); // refs = 0, closed + evicted
    expect(anim.frames[0]!.close).toHaveBeenCalledTimes(1);
    expect(anim.frames[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("re-decodes after full eviction", async () => {
    const decode: DecodeFn = vi.fn(async () => fakeAnimation());
    const cache = createAnimatedImageCache(decode);
    await cache.acquire("k", "url", 10, 10);
    cache.release("k");
    await cache.acquire("k", "url", 10, 10);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("closes frames if released before decode resolves (no leak)", async () => {
    const anim = fakeAnimation();
    let resolve!: (a: DecodedAnimation) => void;
    const decode: DecodeFn = vi.fn(
      () => new Promise<DecodedAnimation>((r) => { resolve = r; }),
    );
    const cache = createAnimatedImageCache(decode);
    const p = cache.acquire("k", "url", 10, 10);
    cache.release("k"); // released while decode is still in flight
    resolve(anim);
    await p;
    expect(anim.frames[0]!.close).toHaveBeenCalledTimes(1);
  });
});
