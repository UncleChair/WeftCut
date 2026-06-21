import { describe, it, expect } from "vitest";
import { isVisualKind } from "./PropertyPanel";

describe("isVisualKind", () => {
  it("is true for the five visual kinds", () => {
    for (const k of ["Text", "VideoClip", "ImageOverlay", "Color", "Motif"]) {
      expect(isVisualKind(k)).toBe(true);
    }
  });
  it("is false for Audio and anything else", () => {
    expect(isVisualKind("Audio")).toBe(false);
    expect(isVisualKind("Whatever")).toBe(false);
  });
});
