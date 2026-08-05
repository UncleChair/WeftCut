import { describe, expect, it } from "vitest";
import { animatableParams, readParamTrack, readScaleLinked } from "./descriptors";
import type { AnimTrack, LayerSummary } from "../ipc";

describe("animatableParams", () => {
  it("visual layers expose the complete transform plus opacity", () => {
    // The anchor pair is part of "the complete transform": it is a keyframeable
    // Animated track on the wire like the rest (main/state/model.ts), so leaving
    // it out here would silently deny it a stopwatch, a timeline lane and a
    // curve — the whole point of storing it as a track.
    const complete = [
      "x", "y", "scale_x", "scale_y", "rotation_deg", "anchor_x", "anchor_y", "opacity",
    ];
    for (const kind of ["VideoClip", "ImageOverlay", "Text", "Motif"]) {
      expect(animatableParams(kind).map((d) => d.paramKey)).toEqual(complete);
    }
  });
  it("Audio exposes gain_db + pan", () => {
    expect(animatableParams("Audio").map((d) => d.paramKey)).toEqual(["gain_db", "pan"]);
  });
  it("Color has no animatable params", () => {
    expect(animatableParams("Color")).toEqual([]);
  });
  it("scaleLinked collapses the pair into ONE composite Scale for every visual kind", () => {
    for (const kind of ["VideoClip", "ImageOverlay", "Text", "Motif"]) {
      const linked = animatableParams(kind, true);
      expect(linked.map((d) => d.paramKey)).toEqual([
        "x", "y", "scale_x", "rotation_deg", "anchor_x", "anchor_y", "opacity",
      ]);
      const scale = linked[2]!;
      expect(scale.labelKey).toBe("property_panel.scale");
      expect(scale.fanOutKeys).toEqual(["scale_x", "scale_y"]);
    }
    // Non-transform kinds ignore the flag.
    expect(animatableParams("Audio", true).map((d) => d.paramKey)).toEqual(["gain_db", "pan"]);
  });
});

describe("readScaleLinked", () => {
  it("true only for an explicit true on the params view", () => {
    expect(readScaleLinked({ kind: "VideoClip", scale_linked: true } as unknown as LayerSummary["params"])).toBe(true);
    expect(readScaleLinked({ kind: "VideoClip", scale_linked: false } as unknown as LayerSummary["params"])).toBe(false);
    expect(readScaleLinked({ kind: "Color" } as unknown as LayerSummary["params"])).toBe(false);
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
