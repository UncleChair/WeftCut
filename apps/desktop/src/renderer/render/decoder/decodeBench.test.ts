import { describe, expect, it } from "vitest";
import { percentile, seekPlan, waitContains } from "./decodeBench";
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
