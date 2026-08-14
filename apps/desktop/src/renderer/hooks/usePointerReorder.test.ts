import { describe, it, expect } from "vitest";
import { isNoopGap } from "./usePointerReorder";

describe("isNoopGap", () => {
  it("the origin gap and the following gap are the same position — both noop", () => {
    expect(isNoopGap(2, 2)).toBe(true);
    expect(isNoopGap(3, 2)).toBe(true);
  });

  it("any other gap moves the row", () => {
    expect(isNoopGap(0, 2)).toBe(false);
    expect(isNoopGap(1, 2)).toBe(false);
    expect(isNoopGap(4, 2)).toBe(false);
  });

  it("holds at the list edges", () => {
    // First row: gaps 0 and 1 are its own position.
    expect(isNoopGap(0, 0)).toBe(true);
    expect(isNoopGap(1, 0)).toBe(true);
    expect(isNoopGap(2, 0)).toBe(false);
    // Last row of a 3-row list: gaps 2 and 3 are its own position.
    expect(isNoopGap(2, 2)).toBe(true);
    expect(isNoopGap(3, 2)).toBe(true);
  });
});
