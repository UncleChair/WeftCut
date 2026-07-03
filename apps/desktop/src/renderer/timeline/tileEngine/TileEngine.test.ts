import { describe, it, expect, vi, beforeEach } from "vitest";
import { TileEngine, ERROR_RETRY_COOLDOWN_MS, type TileProducer, type TileKey } from "./TileEngine";

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

  it("invalidateOn kinds route job-complete events to the producer", async () => {
    const invalidatedA: string[] = [];
    const { producer: producerA, resolve: resolveA } = makeProducer({
      kind: "filmstrip",
      invalidateOn: ["proxy", "quick_proxy"],
      invalidate: (mediaId) => invalidatedA.push(mediaId),
    });
    const invalidatedB: string[] = [];
    const { producer: producerB, resolve: resolveB } = makeProducer({
      kind: "waveform",
      invalidate: (mediaId) => invalidatedB.push(mediaId),
    });
    engine.register(producerA);
    engine.register(producerB);

    const keyA: TileKey = { mediaId: "m1", kind: "filmstrip", lod: 0, index: 0 };
    const keyB: TileKey = { mediaId: "m1", kind: "waveform", lod: 0, index: 0 };
    engine.request(keyA);
    resolveA("0:0", [1]);
    await Promise.resolve();
    engine.request(keyB);
    resolveB("0:0", [2]);
    await Promise.resolve();
    expect(engine.get(keyA)?.state).toBe("ready");
    expect(engine.get(keyB)?.state).toBe("ready");

    // An unknown kind is a no-op: no producer's kind or invalidateOn matches,
    // so no invalidate fires and no slot is dropped. This IS the guard — the
    // event handler has no registered-kind pre-filter anymore.
    engine.handleJobComplete("m1", "some-unknown-kind");
    expect(engine.get(keyA)?.state).toBe("ready");
    expect(engine.get(keyB)?.state).toBe("ready");
    expect(invalidatedA).toEqual([]);
    expect(invalidatedB).toEqual([]);

    engine.handleJobComplete("m1", "proxy");
    expect(engine.get(keyA)).toBeUndefined();
    expect(invalidatedA).toEqual(["m1"]);
    // The waveform producer's own kind doesn't match "proxy" and it declares
    // no invalidateOn, so it's untouched.
    expect(engine.get(keyB)?.state).toBe("ready");
    expect(invalidatedB).toEqual([]);

    // Every invalidateOn entry routes, not just the first.
    engine.handleJobComplete("m1", "quick_proxy");
    expect(invalidatedA).toEqual(["m1", "m1"]);
    expect(invalidatedB).toEqual([]);

    engine.handleJobComplete("m1", "waveform");
    expect(engine.get(keyB)).toBeUndefined();
    expect(invalidatedB).toEqual(["m1"]);
  });

  it("invalidateMedia notifies subscribers even with zero matching slots", () => {
    const { producer } = makeProducer();
    engine.register(producer);
    const cb = vi.fn();
    engine.subscribe("m", cb);
    // Unconditional notify is the contract: a consumer holding an assembled
    // window must re-run assembly on invalidation even when the engine held
    // no tile slots for the media (producer-side caches such as the waveform
    // level table can be the only state that went stale).
    engine.invalidateMedia("m", "test");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("evicts per producer kind: one kind's pressure leaves other kinds alone", async () => {
    const big = Array.from({ length: 80 }, (_, i) => i); // 640 bytes
    const a = makeProducer({ kind: "a", budgetBytes: 800 });
    const b = makeProducer({ kind: "b", budgetBytes: 10_000 });
    engine.register(a.producer);
    engine.register(b.producer);

    const kb: TileKey = { mediaId: "m", kind: "b", lod: 0, index: 0 };
    engine.request(kb); b.resolve("0:0", big); await Promise.resolve();

    const ka0: TileKey = { mediaId: "m", kind: "a", lod: 0, index: 0 };
    const ka1: TileKey = { mediaId: "m", kind: "a", lod: 0, index: 1 };
    engine.request(ka0); a.resolve("0:0", big); await Promise.resolve();
    engine.request(ka1); a.resolve("0:1", big); await Promise.resolve();

    // kind a is over ITS 800-byte budget (1280) -> evicts its own oldest.
    // kind b's tile is the globally oldest touch but must be untouched.
    expect(engine.get(kb)?.state).toBe("ready");
    expect(engine.get(ka0)).toBeUndefined();
    expect(engine.get(ka1)?.state).toBe("ready");
  });

  it("re-requests an error slot only after the cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const calls: TileKey[] = [];
      let reject: (e: unknown) => void = () => {};
      let resolveSecond: (v: number[]) => void = () => {};
      const producer: TileProducer<number[]> = {
        kind: "test",
        fetch: (key) => {
          calls.push(key);
          if (calls.length === 1) return new Promise<number[]>((_res, rej) => { reject = rej; });
          return new Promise<number[]>((res) => { resolveSecond = res; });
        },
        bytes: (v) => v.length * 8,
      };
      engine.register(producer);
      const key: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };

      engine.request(key);
      reject("boom");
      await Promise.resolve();
      await Promise.resolve();
      expect(engine.get(key)?.state).toBe("error");

      engine.request(key);
      expect(calls.length).toBe(1); // still within cooldown: coalesced

      vi.setSystemTime(ERROR_RETRY_COOLDOWN_MS);
      engine.request(key);
      expect(calls.length).toBe(2);
      resolveSecond([1, 2]);
      await Promise.resolve();
      expect(engine.get(key)).toEqual({ state: "ready", value: [1, 2] });
    } finally {
      vi.useRealTimers();
    }
  });
});
