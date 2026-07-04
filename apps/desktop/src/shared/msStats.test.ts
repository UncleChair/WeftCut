import { describe, it, expect } from "vitest";
import { percentile, msSummary } from "./msStats";

describe("percentile", () => {
  it("linear-interpolates over ascending samples", () => {
    const s = [10, 20, 30, 40, 50];
    expect(percentile(s, 50)).toBe(30);
    expect(percentile(s, 95)).toBeCloseTo(48, 6);
    expect(percentile([42], 95)).toBe(42);
  });
});

describe("msSummary", () => {
  it("summarizes known samples", () => {
    const s = msSummary([10, 20, 30, 40, 50]);
    expect(s.count).toBe(5);
    expect(s.meanMs).toBe(30);
    expect(s.p50Ms).toBe(30);
    expect(s.p95Ms).toBeCloseTo(48, 6);
    expect(s.maxMs).toBe(50);
  });
  it("returns an all-zero summary for empty input", () => {
    expect(msSummary([])).toEqual({ count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  });
});
