import { describe, expect, it } from "vitest";
import { buildThroughputTiming, percentile, seekPlan, waitContains } from "./decodeBench";
import type { SourceHandle } from "./SourceDecoderPool";

describe("percentile", () => {
  it("interpolates on sorted input", () => {
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 95)).toBeCloseTo(3.85, 5);
  });
});

describe("seekPlan", () => {
  const DUR = 60_000_000;
  it("emits exactly 40 targets cycling the four categories", () => {
    const plan = seekPlan(DUR);
    expect(plan).toHaveLength(40);
    expect(plan.map((p) => p.category).slice(0, 4)).toEqual([
      "forward-near", "forward-far", "backward-near", "backward-far",
    ]);
  });
  it("is deterministic and clamped to [0.5s, dur-2s]", () => {
    const a = seekPlan(DUR);
    const b = seekPlan(DUR);
    expect(a).toEqual(b);
    for (const p of a) {
      expect(p.targetUs).toBeGreaterThanOrEqual(500_000);
      expect(p.targetUs).toBeLessThanOrEqual(DUR - 2_000_000);
    }
  });
});

describe("waitContains", () => {
  /// Structural fake: waitContains only touches `requestFrameAt(tUs)` and
  /// `ring.containsPts(tUs)`; everything else on SourceHandle is unused.
  function makeFakeHandle(containsPts: () => boolean, onKick: () => void): SourceHandle {
    return {
      requestFrameAt: (_tUs: number) => onKick(),
      ring: { containsPts: (_tUs: number) => containsPts() },
    } as unknown as SourceHandle;
  }

  it("re-kicks the pump while polling", async () => {
    // The frame only becomes available after 3 kicks — models the pump
    // parking on MAX_QUEUE backpressure until per-iteration requestFrameAt
    // nudges resume it. DISCRIMINATION: a poll-only waitContains (no
    // re-kick in the loop body) never gets containsPts to flip true and
    // hangs to its 30s timeout — this test fails (vitest timeout) against
    // that pre-fix shape; with the re-kick it resolves in a few ms.
    let kicks = 0;
    const fake = makeFakeHandle(
      () => kicks >= 3,
      () => { kicks += 1; },
    );
    await waitContains(fake, 5_000_000, { cancelled: false });
    expect(kicks).toBeGreaterThanOrEqual(3);
  });

  it("cancellation still throws", async () => {
    // Token pre-cancelled: the loop must throw on its first iteration;
    // frame availability never matters (containsPts stays false).
    const fake = makeFakeHandle(() => false, () => undefined);
    await expect(waitContains(fake, 0, { cancelled: true })).rejects.toThrow(
      "bench run cancelled",
    );
  });
});

describe("buildThroughputTiming", () => {
  it("maps the Rust summaries, summarizes preload arrays, and derives IPC transit", () => {
    const rust = {
      coordRtt: { count: 2, meanMs: 68, p50Ms: 66, p95Ms: 90, maxMs: 92 },
      decodeCopy: { count: 2, meanMs: 3, p50Ms: 3, p95Ms: 4, maxMs: 4 },
    };
    const pre = { gvfMs: [1, 1], cibMs: [10, 10], residentMs: [20, 20] };

    const t = buildThroughputTiming(6, rust, pre);

    expect(t.poolSize).toBe(6);
    expect(t.coordRttMs).toEqual({ p50: 66, p95: 90, max: 92, mean: 68, n: 2 });
    expect(t.decodeCopyMs.mean).toBe(3);
    expect(t.preloadResidentMs).toEqual({ p50: 20, p95: 20, max: 20, mean: 20, n: 2 });
    expect(t.createImageBitmapMs.mean).toBe(10);
    // 68 (coord mean) - 20 (resident mean)
    expect(t.ipcTransitMsDerived).toBe(48);
  });

  it("yields NaN stats for empty preload arrays without throwing", () => {
    const rust = {
      coordRtt: { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      decodeCopy: { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    };
    const t = buildThroughputTiming(3, rust, { gvfMs: [], cibMs: [], residentMs: [] });
    expect(t.preloadResidentMs.n).toBe(0);
    expect(Number.isNaN(t.preloadResidentMs.mean)).toBe(true);
  });
});
