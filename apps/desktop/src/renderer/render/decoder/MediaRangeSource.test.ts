import { describe, it, expect, vi } from "vitest";
import { makeRangeFetchMock } from "./testing/rangeFetchMock";
import { MediaRangeSource } from "./MediaRangeSource";

const buf = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));

describe("MediaRangeSource", () => {
  it("getSize reads total from Content-Range of a bytes=0-0 probe", async () => {
    vi.stubGlobal("fetch", makeRangeFetchMock(buf).fetch);
    const src = new MediaRangeSource("weftcut-media://clip");
    expect(await src.options.getSize()).toBe(1000);
    vi.unstubAllGlobals();
  });

  it("read returns the half-open [start,end) byte range", async () => {
    vi.stubGlobal("fetch", makeRangeFetchMock(buf).fetch);
    const src = new MediaRangeSource("weftcut-media://clip");
    const out = await src.options.read(10, 15); // bytes 10..14
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out as Uint8Array).toEqual(buf.subarray(10, 15));
    vi.unstubAllGlobals();
  });

  it("read fulfills a window larger than the server's per-response cap", async () => {
    // The weftcut-media:// Range handler caps each 206 body at a
    // fixed ceiling (~1 MB in production). mediabunny's "network" prefetch
    // asks for larger windows, so `read` must loop across follow-up Range
    // requests; otherwise it returns a short buffer and mediabunny throws
    // "Requested N bytes, but got M" — the preview-freeze bug.
    const big = new Uint8Array(Array.from({ length: 3000 }, (_, i) => i % 256));
    const mock = makeRangeFetchMock(big, { cap: 1000 });
    vi.stubGlobal("fetch", mock.fetch);
    const src = new MediaRangeSource("weftcut-media://clip");
    // Window of 2000 bytes at a non-zero start — exceeds the 1000-byte cap,
    // so a correct reader needs ≥2 Range requests to fill it.
    const out = (await src.options.read(500, 2500)) as Uint8Array;
    expect(out.byteLength).toBe(2000);
    expect(out).toEqual(big.subarray(500, 2500));
    expect(mock.readCalls()).toBeGreaterThan(1);
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
    const src = new MediaRangeSource("weftcut-media://clip");
    const p = src.options.read(0, 10);
    src.dispose();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    vi.unstubAllGlobals();
  });
});
