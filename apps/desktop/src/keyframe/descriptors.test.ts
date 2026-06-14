import { describe, expect, it } from "vitest";
import { animatableParams, readParamTrack } from "./descriptors";
import type { AnimTrack, LayerSummary } from "../ipc";

describe("animatableParams", () => {
  it("VideoClip exposes the five transform+opacity params", () => {
    expect(animatableParams("VideoClip").map((d) => d.paramKey)).toEqual([
      "x", "y", "scale_x", "scale_y", "opacity",
    ]);
  });
  it("ImageOverlay and Text omit scale", () => {
    expect(animatableParams("ImageOverlay").map((d) => d.paramKey)).toEqual(["x", "y", "opacity"]);
    expect(animatableParams("Text").map((d) => d.paramKey)).toEqual(["x", "y", "opacity"]);
  });
  it("Audio exposes gain_db + pan", () => {
    expect(animatableParams("Audio").map((d) => d.paramKey)).toEqual(["gain_db", "pan"]);
  });
  it("Color and Subtitles have no animatable params", () => {
    expect(animatableParams("Color")).toEqual([]);
    expect(animatableParams("Subtitles")).toEqual([]);
  });
});

describe("readParamTrack", () => {
  it("reads the AnimTrack off the flattened params view", () => {
    const track: AnimTrack<number> = { mode: "Static", value: 0.5 };
    const params = { kind: "VideoClip", opacity: track } as unknown as LayerSummary["params"];
    expect(readParamTrack(params, "opacity")).toBe(track);
    expect(readParamTrack(params, "nope")).toBeNull();
  });
});
