import { describe, expect, it } from "vitest";

import type { AnimTrack, LayerParamsView, LayerSummary } from "../ipc";
import { centerShift, layerFrameAt, transformOriginFor } from "./centerInFrame";
import { layerQuad, type LayerQuadInput } from "./gizmoGeometry";
import { quadAabb } from "./previewSnap";

const COMP_W = 1280;
const COMP_H = 720;

/// A media layer: `x`/`y` is the unrotated top-left, 640×360 of content.
const media: LayerQuadInput = {
  x: 0,
  y: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  naturalW: 640,
  naturalH: 360,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  origin: "top-left",
};

/// A Text layer: same size, but `x`/`y` IS the anchor point (ADR 0049).
const text: LayerQuadInput = { ...media, origin: "anchor" };

/// Where the layer's visible box sits after `x`/`y` take the shift — the only
/// thing these commands promise.
function centreAfterShift(frame: LayerQuadInput): { x: number; y: number } {
  const shift = centerShift(frame, COMP_W, COMP_H)!;
  const box = quadAabb(layerQuad({ ...frame, x: frame.x + shift.x, y: frame.y + shift.y }))!;
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

const CENTRE = { x: COMP_W / 2, y: COMP_H / 2 };

describe("transformOriginFor", () => {
  it("gives Text the anchor point and every media kind the top-left", () => {
    expect(transformOriginFor("Text")).toBe("anchor");
    for (const kind of ["VideoClip", "ImageOverlay", "Motif"]) {
      expect(transformOriginFor(kind)).toBe("top-left");
    }
  });
});

describe("centerShift", () => {
  // The slice's acceptance criterion: one formula, two origin conventions.
  it("centres a media layer and a Text layer alike, from different stored origins", () => {
    expect(centerShift(media, COMP_W, COMP_H)).toEqual({ x: 320, y: 180 });
    // Text's x/y is the anchor, and a 0.5 anchor hangs the glyphs symmetrically
    // around it — so the same picture needs a different number.
    expect(centerShift(text, COMP_W, COMP_H)).toEqual({ x: 640, y: 360 });
    expect(centreAfterShift(media)).toEqual(CENTRE);
    expect(centreAfterShift(text)).toEqual(CENTRE);
  });

  it("is already zero for a layer sitting on the centre", () => {
    expect(centerShift({ ...text, x: 640, y: 360 }, COMP_W, COMP_H)).toEqual({ x: 0, y: 0 });
  });

  // Per-origin arithmetic (`comp/2 − natural/2`) would answer 320 here. Going
  // through the AABB is what makes the rotated case fall out.
  it("centres the EXTENT of a rotated, off-anchor layer, not a corner of it", () => {
    const rotated: LayerQuadInput = { ...media, anchorX: 0, anchorY: 0, rotationDeg: 90 };
    expect(centerShift(rotated, COMP_W, COMP_H)).toEqual({ x: 820, y: 40 });
    expect(centreAfterShift(rotated)).toEqual(CENTRE);
  });

  it("centres a non-uniformly scaled and a mirrored layer by their footprint", () => {
    expect(centreAfterShift({ ...media, scaleX: 2, scaleY: 0.5 })).toEqual(CENTRE);
    expect(centreAfterShift({ ...text, scaleX: -1, rotationDeg: 30 })).toEqual(CENTRE);
  });
});

const stat = (value: number): AnimTrack<number> => ({ mode: "Static", value });

function layer(kind: string, params: Record<string, unknown>): LayerSummary {
  return {
    id: "l1",
    label: null,
    t_start_us: 2_000_000,
    t_end_us: 4_000_000,
    kind,
    color_hint: "",
    enabled: true,
    locked: false,
    effects: [],
    params: { kind, ...params } as unknown as LayerParamsView,
  } as unknown as LayerSummary;
}

describe("layerFrameAt", () => {
  it("resolves the transform at the layer-local time and carries the kind's origin", () => {
    const l = layer("Text", {
      x: { mode: "Keyframed", value: [
        { id: "k0", t_us: 0, value: 0, interp: { kind: "Linear" } },
        { id: "k1", t_us: 1_000_000, value: 100, interp: { kind: "Linear" } },
      ] } as AnimTrack<number>,
      y: stat(50),
      scale_x: stat(2),
    });
    // 2.5 s absolute − 2 s layer start = 0.5 s in, halfway along the ramp.
    const frame = layerFrameAt(l, 2_500_000, { w: 400, h: 100 });
    expect(frame.x).toBe(50);
    expect(frame.y).toBe(50);
    expect(frame.scaleX).toBe(2);
    expect(frame.origin).toBe("anchor");
  });

  it("falls back to the renderer's own anchor default when the params carry none", () => {
    const frame = layerFrameAt(layer("VideoClip", { x: stat(0) }), 2_000_000, { w: 640, h: 360 });
    expect(frame.anchorX).toBe(0.5);
    expect(frame.anchorY).toBe(0.5);
    expect(frame.scaleX).toBe(1);
    expect(frame.rotationDeg).toBe(0);
    expect(frame.origin).toBe("top-left");
  });
});
