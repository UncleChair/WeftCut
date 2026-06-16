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

const byKey = (kind: string, key: string) =>
  animatableParams(kind).find((d) => d.paramKey === key)!;

describe("ParamDescriptor metadata", () => {
  it("opacity is a slider+readout, 0..1 step 0.01", () => {
    const d = byKey("VideoClip", "opacity");
    expect(d.step).toBe(0.01);
    expect(d.min).toBe(0);
    expect(d.max).toBe(1);
    expect(d.widgets).toEqual(["slider", "readout"]);
  });

  it("x/y are plain number fields, step 1", () => {
    const d = byKey("Text", "x");
    expect(d.step).toBe(1);
    expect(d.widgets).toEqual(["number"]);
  });

  it("scale is a number field, step 0.05", () => {
    expect(byKey("Motif", "scale_x").step).toBe(0.05);
    expect(byKey("Motif", "scale_x").widgets).toEqual(["number"]);
  });

  it("gain_db is a number field -30..20 step 0.5; pan is a slider -1..1 step 0.05", () => {
    const g = byKey("Audio", "gain_db");
    expect([g.step, g.min, g.max]).toEqual([0.5, -30, 20]);
    expect(g.widgets).toEqual(["number"]);
    const p = byKey("Audio", "pan");
    expect([p.step, p.min, p.max]).toEqual([0.05, -1, 1]);
    expect(p.widgets).toEqual(["slider"]);
  });
});
