import { describe, expect, it } from "vitest";
import { swapKeys } from "./swapKeys";

describe("swapKeys", () => {
  it("derives deterministic keys", () => {
    const a = swapKeys("L1", "M1");
    expect(a).toEqual({ swapLayerId: "L1#swap", swapMediaId: "M1#swap" });
    expect(swapKeys("L1", "M1")).toEqual(a);
  });

  it("never collides with the original keys", () => {
    const { swapLayerId, swapMediaId } = swapKeys("L1", "M1");
    expect(swapLayerId).not.toBe("L1");
    expect(swapMediaId).not.toBe("M1");
  });

  it("distinct sources yield distinct keys", () => {
    expect(swapKeys("L1", "M1").swapLayerId).not.toBe(swapKeys("L2", "M1").swapLayerId);
    expect(swapKeys("L1", "M1").swapMediaId).not.toBe(swapKeys("L1", "M2").swapMediaId);
  });
});
