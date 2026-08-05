import { describe, expect, it } from "vitest";

import {
  angleAboutDeg,
  clientDeltaToComp,
  compToClient,
  containFit,
  layerPivot,
  layerQuad,
  rotateHandle,
  shortestDeltaDeg,
  snapAngleDeg,
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

describe("layerPivot", () => {
  it("is the quad's centroid for a centered anchor, at any rotation or scale", () => {
    // This equality is what makes a rotation gesture turn the layer IN PLACE:
    // rotate about this point and the footprint's centre never moves.
    for (const rotationDeg of [0, 30, 90, -145]) {
      const i = { ...mediaLayer, rotationDeg, scaleX: 2, scaleY: 0.5 };
      const q = layerQuad(i);
      const p = layerPivot(i);
      expect(p.x).toBeCloseTo(q.reduce((s, c) => s + c.x, 0) / 4, 9);
      expect(p.y).toBeCloseTo(q.reduce((s, c) => s + c.y, 0) / 4, 9);
    }
  });

  it("is (x, y) itself for an anchor-origin layer (Text)", () => {
    // Text's x/y IS the anchor point, so the pivot is the stored position
    // whatever the anchor pair says.
    expect(layerPivot({ ...mediaLayer, origin: "anchor", anchorX: 0, anchorY: 1 })).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("offsets by the anchor for a top-left-origin layer", () => {
    // Top-left anchor ⇒ the pivot IS (x, y); position compensation is zero.
    expect(layerPivot({ ...mediaLayer, anchorX: 0, anchorY: 0 })).toEqual({ x: 100, y: 50 });
  });
});

describe("rotateHandle", () => {
  /// 320×180 box at the client origin — the fixture the component test draws.
  const box = [
    { x: 0, y: 0 },
    { x: 320, y: 0 },
    { x: 320, y: 180 },
    { x: 0, y: 180 },
  ];

  it("hangs the knob off the top edge's midpoint by a screen-space gap", () => {
    expect(rotateHandle(box, 26)).toEqual({ root: { x: 160, y: 0 }, knob: { x: 160, y: -26 } });
  });

  it("follows the box's own up direction when it is rotated", () => {
    // The same content rotated 90° clockwise: "up" is now screen-right.
    const h = rotateHandle(
      [
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
        { x: 0, y: 0 },
      ],
      26,
    )!;
    expect(h.root).toEqual({ x: 100, y: 50 });
    expect(h.knob.x).toBeCloseTo(126, 9);
    expect(h.knob.y).toBeCloseTo(50, 9);
  });

  it("falls back to the top edge's perpendicular for a flattened box", () => {
    // scale_y 0 leaves no body to point away from; the handle must still exist.
    const flat = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
    ];
    expect(rotateHandle(flat, 26)!.knob).toEqual({ x: 50, y: -26 });
  });

  it("falls back to straight up for a fully collapsed box, and is null under 4 corners", () => {
    const point = Array.from({ length: 4 }, () => ({ x: 7, y: 9 }));
    expect(rotateHandle(point, 26)!.knob).toEqual({ x: 7, y: 9 - 26 });
    expect(rotateHandle(box.slice(0, 3), 26)).toBeNull();
  });
});

describe("rotation angles", () => {
  const origin = { x: 0, y: 0 };

  it("measures clockwise-positive, matching rotation_deg's direction", () => {
    expect(angleAboutDeg(origin, { x: 1, y: 0 })).toBe(0);
    // Screen y grows downward, so straight down is +90 — the same way a
    // positive rotation_deg turns the picture.
    expect(angleAboutDeg(origin, { x: 0, y: 1 })).toBe(90);
    expect(angleAboutDeg(origin, { x: 0, y: -1 })).toBe(-90);
  });

  it("reads a drag across the ±180° cut as the short way round", () => {
    // 170° → −170° is +20° of cursor movement, not −340°.
    expect(shortestDeltaDeg(-170 - 170)).toBeCloseTo(20, 9);
    expect(shortestDeltaDeg(370)).toBeCloseTo(10, 9);
    // Accumulating increments is what permits multi-turn rotation: dragging
    // through three 170° steps is 510°, not 150°.
    let acc = 0;
    for (let step = 0; step < 3; step++) acc += shortestDeltaDeg(170);
    expect(acc).toBeCloseTo(510, 9);
  });

  it("snaps the absolute angle to the nearest step, and is identity without one", () => {
    expect(snapAngleDeg(20, 15)).toBe(15);
    expect(snapAngleDeg(7, 15)).toBe(0);
    expect(snapAngleDeg(-8, 15)).toBe(-15);
    expect(snapAngleDeg(20.4, 0)).toBe(20.4);
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
