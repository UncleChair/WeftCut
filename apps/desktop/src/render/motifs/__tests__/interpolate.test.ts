import { describe, it, expect } from "vitest";
import { interpolate } from "../interpolate";

describe("interpolate", () => {
  it("maps linearly across the range", () => {
    expect(interpolate(0.5, [0, 1], [0, 100])).toBe(50);
  });
  it("clamps outside the input range by default", () => {
    expect(interpolate(-1, [0, 1], [0, 100])).toBe(0);
    expect(interpolate(2, [0, 1], [0, 100])).toBe(100);
  });
  it("supports multi-segment ranges", () => {
    expect(interpolate(1.5, [0, 1, 2], [0, 10, 0])).toBe(5);
  });
  it("applies an easing function before mapping", () => {
    const ease = (x: number) => x * x;
    expect(interpolate(0.5, [0, 1], [0, 100], { easing: ease })).toBe(25);
  });
});
