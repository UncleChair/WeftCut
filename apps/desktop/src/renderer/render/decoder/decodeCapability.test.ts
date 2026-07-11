import { describe, expect, it, vi } from "vitest";
import {
  kickSwProbe,
  laneStatesFor,
  resetDecodeCapabilitySession,
  setSwLane,
} from "./decodeCapability";

// D3 renderer-side loop (Task 14): kickSwProbe closes the probe→setSwLane→
// onSettled rhythm without touching `window` — the injectable `probeFn`
// mirrors `loadNativeDecodeWith`'s seam so these run under plain vitest.

describe("kickSwProbe", () => {
  it("single-flight: two rapid kicks for the same media call the probe once and settle once, landing ok", async () => {
    resetDecodeCapabilitySession();
    let calls = 0;
    const probeFn = async (_p: string) => {
      calls++;
      return { ok: true, classKey: "k", reason: null };
    };
    const settled = vi.fn();
    kickSwProbe("m1", "C:/a.mov", settled, probeFn);
    kickSwProbe("m1", "C:/a.mov", settled, probeFn); // deduped while in flight
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(calls).toBe(1);
    expect(
      laneStatesFor("m1", { decode_route: { route: "proxied" } }).nativeSw,
    ).toBe("ok");
  });

  it("a failing probe sets the lane to fail and still settles", async () => {
    resetDecodeCapabilitySession();
    const settled = vi.fn();
    kickSwProbe("m2", "C:/b.mov", settled, async () => ({
      ok: false,
      classKey: null,
      reason: "unsupported",
    }));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(
      laneStatesFor("m2", { decode_route: { route: "proxied" } }).nativeSw,
    ).toBe("fail");
  });

  it("a rejecting probe is treated as fail (never leaves the lane untested)", async () => {
    resetDecodeCapabilitySession();
    const settled = vi.fn();
    kickSwProbe("m3", "C:/c.mov", settled, async () => {
      throw new Error("probe crashed");
    });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(
      laneStatesFor("m3", { decode_route: { route: "proxied" } }).nativeSw,
    ).toBe("fail");
  });

  it("does not re-kick once the lane already holds a verdict", async () => {
    resetDecodeCapabilitySession();
    setSwLane("m4", "ok");
    const probeFn = vi.fn(async () => ({ ok: false, classKey: null, reason: null }));
    const settled = vi.fn();
    kickSwProbe("m4", "C:/d.mov", settled, probeFn);
    expect(probeFn).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });
});
