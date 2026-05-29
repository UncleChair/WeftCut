import { describe, it, expect, vi } from "vitest";
import { makeRangeFetchMock } from "./testing/rangeFetchMock";
import { AssetRangeSource } from "./AssetRangeSource";

const buf = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));

describe("AssetRangeSource", () => {
  it("getSize reads total from Content-Range of a bytes=0-0 probe", async () => {
    vi.stubGlobal("fetch", makeRangeFetchMock(buf).fetch);
    const src = new AssetRangeSource("asset://clip");
    expect(await src.options.getSize()).toBe(1000);
    vi.unstubAllGlobals();
  });

  it("read returns the half-open [start,end) byte range", async () => {
    vi.stubGlobal("fetch", makeRangeFetchMock(buf).fetch);
    const src = new AssetRangeSource("asset://clip");
    const out = await src.options.read(10, 15); // bytes 10..14
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out as Uint8Array).toEqual(buf.subarray(10, 15));
    vi.unstubAllGlobals();
  });

  it("dispose aborts; subsequent read rejects with AbortError", async () => {
    vi.stubGlobal(
      "fetch",
      (_u: string, init?: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const src = new AssetRangeSource("asset://clip");
    const p = src.options.read(0, 10);
    src.dispose();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    vi.unstubAllGlobals();
  });
});
