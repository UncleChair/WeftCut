import { describe, expect, it } from "vitest";
import { timelineLayerTheme } from "./layerTheme";

describe("timelineLayerTheme", () => {
  it("uses a stable low-chroma palette for content layers", () => {
    expect(timelineLayerTheme("VideoClip", "#ff0000")).toEqual({
      surface: "#1a222d",
      accent: "#6f91b8",
    });
    expect(timelineLayerTheme("Audio", "#00ff00")).toEqual({
      surface: "#152723",
      accent: "#55b09d",
    });
  });

  it("preserves the real fill for color layers", () => {
    expect(timelineLayerTheme("Color", "#123456")).toEqual({
      surface: "#123456",
      accent: "transparent",
    });
  });
});
