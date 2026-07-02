import { describe, it, expect, vi, beforeEach } from "vitest";
import { TileEngine, type TileProducer, type TileKey } from "./TileEngine";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));

function makeProducer(overrides: Partial<TileProducer<number[]>> = {}): {
  producer: TileProducer<number[]>;
  calls: TileKey[];
  resolve: (k: string, v: number[]) => void;
} {
  const calls: TileKey[] = [];
  const pending = new Map<string, (v: number[]) => void>();
  const producer: TileProducer<number[]> = {
    kind: "test",
    fetch: (key) => {
      calls.push(key);
      return new Promise<number[]>((res) => pending.set(`${key.lod}:${key.index}`, res));
    },
    bytes: (v) => v.length * 8,
    ...overrides,
  };
  return { producer, calls, resolve: (k, v) => pending.get(k)?.(v) };
}

describe("TileEngine", () => {
  let engine: TileEngine;
  beforeEach(() => { engine = new TileEngine(1000); });

  it("coalesces duplicate in-flight requests for the same key", async () => {
    const { producer, calls } = makeProducer();
    engine.register(producer);
    const key: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    engine.request(key);
    engine.request(key);
    expect(calls.length).toBe(1);
    expect(engine.get(key)?.state).toBe("pending");
  });

  it("stores ready values and notifies subscribers", async () => {
    const { producer, resolve } = makeProducer();
    engine.register(producer);
    const cb = vi.fn();
    engine.subscribe("m", cb);
    const key: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    engine.request(key);
    resolve("0:0", [1, 2, 3]);
    await Promise.resolve();
    expect(engine.get(key)).toEqual({ state: "ready", value: [1, 2, 3] });
    expect(cb).toHaveBeenCalled();
  });

  it("evicts least-recently-used entries past the byte budget and calls dispose", async () => {
    const disposed: number[][] = [];
    const { producer, resolve } = makeProducer({ dispose: (v) => disposed.push(v) });
    engine.register(producer);
    // budget 1000 bytes; each [.. x 80] = 640 bytes. Two fit? 1280 > 1000 -> evict first.
    const big = Array.from({ length: 80 }, (_, i) => i);
    const k0: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    const k1: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 1 };
    engine.request(k0); resolve("0:0", big); await Promise.resolve();
    engine.get(k0); // touch
    engine.request(k1); resolve("0:1", big); await Promise.resolve();
    expect(engine.get(k1)?.state).toBe("ready");
    expect(engine.get(k0)).toBeUndefined(); // evicted
    expect(disposed.length).toBe(1);
  });

  it("invalidateMedia drops that media's entries for the kind", async () => {
    const { producer, resolve } = makeProducer();
    engine.register(producer);
    const key: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    engine.request(key); resolve("0:0", [1]); await Promise.resolve();
    expect(engine.get(key)?.state).toBe("ready");
    engine.invalidateMedia("m", "test");
    expect(engine.get(key)).toBeUndefined();
  });

  it("keeps an in-flight fetch valid when get() touches the pending slot", async () => {
    const { producer, resolve } = makeProducer();
    engine.register(producer);
    const key: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    engine.request(key);
    // A consumer polling mid-flight (e.g. a sibling tile's notify re-running
    // window assembly) must not make the eventual resolve look stale.
    expect(engine.get(key)?.state).toBe("pending");
    resolve("0:0", [1, 2]);
    await Promise.resolve();
    expect(engine.get(key)).toEqual({ state: "ready", value: [1, 2] });
  });

  it("invalidateMedia forwards to the producer's invalidate hook", () => {
    const invalidated: string[] = [];
    const { producer } = makeProducer({ invalidate: (mediaId) => invalidated.push(mediaId) });
    engine.register(producer);
    engine.invalidateMedia("m", "test");
    expect(invalidated).toEqual(["m"]);
  });
});
