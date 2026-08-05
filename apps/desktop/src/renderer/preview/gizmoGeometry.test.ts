import { describe, expect, it } from "vitest";

import {
  clientDeltaToComp,
  compToClient,
  containFit,
  layerQuad,
  type LayerQuadInput,
} from "./gizmoGeometry";

const mediaLayer: LayerQuadInput = {
  x: 100,
  y: 50,
  anchorX: 0.5,
  anchorY: 0.5,
  naturalW: 200,
  naturalH: 100,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  origin: "top-left",
};

describe("layerQuad", () => {
  it("boxes a top-left-origin layer from (x, y) at its scaled size", () => {
    const q = layerQuad({ ...mediaLayer, scaleX: 2, scaleY: 0.5 });
    expect(q[0]).toEqual({ x: 100, y: 50 });
    expect(q[2]).toEqual({ x: 500, y: 100 });
  });

  it("hangs an anchor-origin layer (Text) off its anchor point", () => {
    // Bottom-center anchor: the box sits above (x, y) and straddles it.
    const q = layerQuad({
      ...mediaLayer,
      origin: "anchor",
      anchorX: 0.5,
      anchorY: 1,
    });
    expect(q[0]).toEqual({ x: 0, y: -50 });
    expect(q[2]).toEqual({ x: 200, y: 50 });
  });

  it("rotates about the anchor, leaving the footprint centered", () => {
    const q = layerQuad({ ...mediaLayer, rotationDeg: 90 });
    const cx = q.reduce((s, p) => s + p.x, 0) / 4;
    const cy = q.reduce((s, p) => s + p.y, 0) / 4;
    // Same center as the unrotated box: (100+200/2, 50+100/2).
    expect(cx).toBeCloseTo(200, 9);
    expect(cy).toBeCloseTo(100, 9);
    // 90°: the box is now 100 wide and 200 tall.
    const xs = q.map((p) => p.x);
    const ys = q.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(200, 9);
  });

  it("boxes an absent anchor exactly like the stored 0.5 default", () => {
    // Both origins: a version-skewed summary that omits anchor_x/anchor_y must
    // still draw the box where the renderer draws the picture.
    for (const origin of ["top-left", "anchor"] as const) {
      expect(
        layerQuad({ ...mediaLayer, origin, anchorX: undefined, anchorY: undefined, rotationDeg: 30 }),
      ).toEqual(
        layerQuad({ ...mediaLayer, origin, anchorX: 0.5, anchorY: 0.5, rotationDeg: 30 }),
      );
    }
  });

  it("returns corners in content order, so a rotated box is traceable", () => {
    const q = layerQuad({ ...mediaLayer, rotationDeg: 90 });
    // Content top-left → top-right is one 200 px edge, whatever the rotation.
    const edge = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
    expect(edge).toBeCloseTo(200, 9);
  });
});

describe("containFit", () => {
  const rect = { left: 10, top: 20, width: 640, height: 360 };

  it("maps a matching aspect with no letterbox", () => {
    const fit = containFit(rect, 1280, 720)!;
    expect(fit.scale).toBe(0.5);
    expect(fit).toMatchObject({ offX: 10, offY: 20 });
    expect(compToClient({ x: 1280, y: 720 }, fit)).toEqual({ x: 650, y: 380 });
  });

  it("centers the content when the aspects differ", () => {
    // 1:1 composition in a 16:9 box ⇒ pillarboxed, scale bound by height.
    const fit = containFit(rect, 720, 720)!;
    expect(fit.scale).toBe(0.5);
    expect(fit.offX).toBe(10 + (640 - 360) / 2);
    expect(fit.offY).toBe(20);
  });

  it("is null for a degenerate box or composition", () => {
    expect(containFit({ left: 0, top: 0, width: 0, height: 0 }, 1280, 720)).toBeNull();
    expect(containFit(rect, 0, 720)).toBeNull();
  });

  it("scales a client drag UP into composition pixels on a shrunken preview", () => {
    const fit = containFit(rect, 1280, 720)!;
    expect(clientDeltaToComp(10, -4, fit)).toEqual({ x: 20, y: -8 });
  });
});
