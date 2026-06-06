import { describe, expect, it } from "vitest";
import { RasterPool, type RasterSlot } from "./rasterPool";

function makeBmp(): ImageBitmap {
  return { close() {} } as unknown as ImageBitmap;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/// Fake slot factory: every `rasterize` call parks a deferred the test resolves
/// or rejects on demand, so dispatch/queue/recycle behavior is observable.
function fakeSlots() {
  const calls: { svg: string; slotId: number; d: ReturnType<typeof deferred<ImageBitmap>> }[] = [];
  const disposed: number[] = [];
  let seq = 0;
  const createSlot = (): RasterSlot => {
    const slotId = seq++;
    return {
      rasterize(svg: string) {
        const d = deferred<ImageBitmap>();
        calls.push({ svg, slotId, d });
        return d.promise;
      },
      dispose() {
        disposed.push(slotId);
      },
    };
  };
  return { createSlot, calls, disposed };
}

const tick = () => Promise.resolve();

describe("RasterPool", () => {
  it("dispatches a job to a free slot and resolves with its bitmap", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 2, createSlot: f.createSlot });
    const p = pool.rasterize("a");
    await tick();
    expect(f.calls.length).toBe(1);
    const bmp = makeBmp();
    f.calls[0]!.d.resolve(bmp);
    expect(await p).toBe(bmp);
  });

  it("caps concurrency at the pool size and FIFO-queues the rest", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 2, createSlot: f.createSlot });
    pool.rasterize("a");
    pool.rasterize("b");
    pool.rasterize("c");
    await tick();
    expect(f.calls.map((c) => c.svg)).toEqual(["a", "b"]); // only 2 in flight
    f.calls[0]!.d.resolve(makeBmp()); // free a slot
    await tick();
    await tick();
    expect(f.calls.map((c) => c.svg)).toEqual(["a", "b", "c"]); // c dispatched next
  });

  it("recycles a slot and rejects the call when a raster fails", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 1, createSlot: f.createSlot });
    const p = pool.rasterize("a");
    await tick();
    f.calls[0]!.d.reject(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    expect(f.disposed).toContain(0); // wedged slot torn down
    pool.rasterize("b"); // next call builds a fresh slot
    await tick();
    expect(f.calls.length).toBe(2);
  });

  it("disables itself (fast-fail) after maxConsecutiveFailures", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 1, createSlot: f.createSlot, maxConsecutiveFailures: 2 });
    const p1 = pool.rasterize("a");
    await tick();
    f.calls[0]!.d.reject(new Error("x"));
    await p1.catch(() => {});
    const p2 = pool.rasterize("b");
    await tick();
    f.calls[1]!.d.reject(new Error("y"));
    await p2.catch(() => {});
    expect(pool.disabled).toBe(true);
    await expect(pool.rasterize("c")).rejects.toThrow(/disabled/);
    expect(f.calls.length).toBe(2); // c never reached a slot
  });

  it("resets the failure counter on a success", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 1, createSlot: f.createSlot, maxConsecutiveFailures: 2 });
    const p1 = pool.rasterize("a");
    await tick();
    f.calls[0]!.d.reject(new Error("x"));
    await p1.catch(() => {});
    const p2 = pool.rasterize("b");
    await tick();
    f.calls[1]!.d.resolve(makeBmp());
    await p2;
    expect(pool.disabled).toBe(false);
  });

  it("rejects queued jobs and disposes slots on dispose()", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 1, createSlot: f.createSlot });
    pool.rasterize("a"); // in flight
    const p2 = pool.rasterize("b"); // queued
    await tick();
    pool.dispose();
    await expect(p2).rejects.toThrow(/disposed/);
    expect(f.disposed).toContain(0);
  });
});
