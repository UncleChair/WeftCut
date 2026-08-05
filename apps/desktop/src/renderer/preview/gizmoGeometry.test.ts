import { describe, expect, it } from "vitest";

import {
  anchorCompensation,
  angleAboutDeg,
  clientDeltaToComp,
  compDeltaToLocal,
  compToClient,
  containFit,
  handleOutwardDeg,
  layerPivot,
  layerQuad,
  resizeCursorForDeg,
  rotateHandle,
  scaleCompensation,
  scaleHandleOffset,
  scaleHandlePoints,
  shortestDeltaDeg,
  snapAngleDeg,
  solveScale,
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

describe("compDeltaToLocal", () => {
  it("is the identity on an unrotated, unit-scaled layer", () => {
    expect(compDeltaToLocal({ x: 30, y: -12 }, mediaLayer)).toEqual({ x: 30, y: -12 });
  });

  it("un-rotates and un-scales, so a screen drag means what it does LOCALLY", () => {
    // Rotated 90° clockwise: dragging right in composition space walks UP the
    // layer's own y axis. This is the whole reason an anchor drag can't use the
    // composition delta directly.
    const r = compDeltaToLocal({ x: 80, y: 0 }, { ...mediaLayer, rotationDeg: 90 })!;
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(-80, 9);
    // Non-uniform scale divides per axis.
    expect(
      compDeltaToLocal({ x: 80, y: 30 }, { ...mediaLayer, scaleX: 4, scaleY: 0.5 }),
    ).toEqual({ x: 20, y: 60 });
  });

  it("is null on a flattened axis rather than returning Infinity", () => {
    expect(compDeltaToLocal({ x: 1, y: 1 }, { ...mediaLayer, scaleX: 0 })).toBeNull();
    expect(compDeltaToLocal({ x: 1, y: 1 }, { ...mediaLayer, scaleY: 0 })).toBeNull();
  });
});

describe("anchorCompensation", () => {
  it("is ZERO for an unrotated, unflipped media layer at any scale", () => {
    // The pivot moves and the picture does not — so the gesture writes the
    // anchor pair alone, and no redundant key lands on x/y.
    for (const scale of [1, 3, 0.25]) {
      const c = anchorCompensation(
        { ...mediaLayer, scaleX: scale, scaleY: scale },
        0.25,
        -0.5,
      );
      expect(c.x).toBeCloseTo(0, 9);
      expect(c.y).toBeCloseTo(0, 9);
    }
  });

  it("holds a rotated media layer's picture still", () => {
    // 200×100 layer rotated 90°, anchor moved −0.2222 on the local y axis
    // (= −80 px): (|S| − R·S)·q = (−80, −80), so the fix is (+80, +80).
    const c = anchorCompensation({ ...mediaLayer, rotationDeg: 90 }, 0, -0.8);
    expect(c.x).toBeCloseTo(80, 9);
    expect(c.y).toBeCloseTo(80, 9);
  });

  it("always compensates a Text layer, because its x/y IS the anchor point", () => {
    // No rotation, unit scale: the glyphs hang off (x, y), so moving the anchor
    // half a width to the right must move x half a width right to stay put.
    const c = anchorCompensation({ ...mediaLayer, origin: "anchor" }, 0.5, 0.25);
    expect(c).toEqual({ x: 100, y: 25 });
  });

  it("mirrors the compensation for a flipped layer", () => {
    // Flip is a negative scale. The pivot term uses |scale| and the rotation
    // term the signed one, which is what keeps a flip mirroring IN PLACE
    // (anchorPivot.ts) — so the two no longer cancel at rotation 0.
    const c = anchorCompensation({ ...mediaLayer, scaleX: -1 }, 0.5, 0);
    expect(c.x).toBeCloseTo(-200, 9);
    expect(c.y).toBeCloseTo(0, 9);
  });
});

describe("scaleHandleOffset", () => {
  it("is half the natural size at the corners of a centre-anchored layer", () => {
    expect(scaleHandleOffset(mediaLayer, "br")).toEqual({ x: 100, y: 50 });
    expect(scaleHandleOffset(mediaLayer, "tl")).toEqual({ x: -100, y: -50 });
  });

  it("is the SAME for both origin conventions", () => {
    // Top-left origin puts the pivot at the anchor; anchor origin moves the rect
    // instead. Either way the handle's offset from the pivot is (frac−anchor)·size,
    // which is why one solve serves Text and the media kinds alike.
    for (const id of ["tl", "t", "br", "r"] as const) {
      expect(scaleHandleOffset({ ...mediaLayer, origin: "anchor", anchorX: 0.25 }, id)).toEqual(
        scaleHandleOffset({ ...mediaLayer, anchorX: 0.25 }, id),
      );
    }
  });

  it("puts an off-centre anchor's top-edge midpoint OFF the pivot's column", () => {
    // The reason the driven-axis mask can't be inferred from a zero offset: this
    // handle has a non-zero x offset and must still scale y alone.
    expect(scaleHandleOffset({ ...mediaLayer, anchorX: 0.25 }, "t")).toEqual({ x: 50, y: -50 });
  });
});

describe("scaleHandlePoints", () => {
  const box = [
    { x: 0, y: 0 },
    { x: 320, y: 0 },
    { x: 320, y: 180 },
    { x: 0, y: 180 },
  ];

  it("places corners on the quad and edge handles on its midpoints", () => {
    const at = new Map(scaleHandlePoints(box)!.map((h) => [h.id, h.at]));
    expect(at.get("tl")).toEqual({ x: 0, y: 0 });
    expect(at.get("br")).toEqual({ x: 320, y: 180 });
    expect(at.get("t")).toEqual({ x: 160, y: 0 });
    expect(at.get("l")).toEqual({ x: 0, y: 90 });
  });

  it("follows a rotated box's own corners, and is null under 4", () => {
    // The same content turned 90° clockwise: its own "tl" is now top-right.
    const at = new Map(
      scaleHandlePoints([
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
        { x: 0, y: 0 },
      ])!.map((h) => [h.id, h.at]),
    );
    expect(at.get("tl")).toEqual({ x: 100, y: 0 });
    expect(at.get("t")).toEqual({ x: 100, y: 50 });
    expect(scaleHandlePoints(box.slice(0, 3))).toBeNull();
  });

  it("lists the corners LAST, so they win the hit test on a shrunken box", () => {
    const ids = scaleHandlePoints(box)!.map((h) => h.id);
    expect(ids.slice(4)).toEqual(["tl", "tr", "br", "bl"]);
  });
});

describe("solveScale", () => {
  /// The pivot of `mediaLayer`: a 200×100 layer at (100,50), centre-anchored.
  const pivot = { x: 200, y: 100 };

  it("puts the grabbed corner exactly under the cursor", () => {
    // Twice the offset from the pivot ⇒ twice the scale, both axes.
    const s = solveScale(mediaLayer, "br", { x: 400, y: 200 }, pivot, false)!;
    expect(s).toEqual({ scaleX: 2, scaleY: 2 });
  });

  it("scales the axes independently unless asked for uniform", () => {
    const free = solveScale(mediaLayer, "br", { x: 400, y: 150 }, pivot, false)!;
    expect(free).toEqual({ scaleX: 2, scaleY: 1 });
    // Uniform projects the cursor onto the handle's own diagonal instead:
    // t = (b·v)/(b·b) with b = (100, 50), v = (200, 50).
    const locked = solveScale(mediaLayer, "br", { x: 400, y: 150 }, pivot, true)!;
    expect(locked.scaleX).toBeCloseTo(1.8, 9);
    expect(locked.scaleY).toBeCloseTo(1.8, 9);
  });

  it("drives ONE axis from an edge handle, whatever the cursor does off it", () => {
    const s = solveScale(mediaLayer, "r", { x: 350, y: -900 }, pivot, false)!;
    expect(s).toEqual({ scaleX: 1.5, scaleY: 1 });
  });

  it("keeps an edge handle on its own axis even with an off-centre anchor", () => {
    // anchor_x 0.25 puts the top handle 50 px right of the pivot; a purely
    // horizontal cursor must still change nothing. Deriving the driven axis from
    // "the offset is zero" instead of from the handle's identity would scale x by 2.
    const layer = { ...mediaLayer, anchorX: 0.25 };
    const p = layerPivot(layer);
    const start = scaleHandlePoints(layerQuad(layer))!.find((h) => h.id === "t")!.at;
    const s = solveScale(layer, "t", { x: start.x + 100, y: start.y }, p, false)!;
    expect(s).toEqual({ scaleX: 1, scaleY: 1 });
  });

  it("converts the cursor through the layer's LOCAL frame when rotated", () => {
    // 90° clockwise: the layer's own +x axis points DOWN the screen, so a purely
    // vertical drag is a pure scale_x change.
    const layer = { ...mediaLayer, rotationDeg: 90 };
    const p = layerPivot(layer);
    const start = scaleHandlePoints(layerQuad(layer))!.find((h) => h.id === "br")!.at;
    const s = solveScale(layer, "br", { x: start.x, y: start.y + 100 }, p, false)!;
    expect(s.scaleX).toBeCloseTo(2, 9);
    expect(s.scaleY).toBeCloseTo(1, 9);
  });

  it("goes negative when the handle is dragged past the pivot, but never to 0", () => {
    const flipped = solveScale(mediaLayer, "br", { x: 0, y: 0 }, pivot, false)!;
    expect(flipped).toEqual({ scaleX: -2, scaleY: -2 });
    // Landing exactly on the pivot would collapse the box to a point, stacking
    // every handle on the reticle with no way to drag back out.
    const collapsed = solveScale(mediaLayer, "br", pivot, pivot, false)!;
    expect(collapsed.scaleX).toBeGreaterThan(0);
    expect(collapsed.scaleX).toBeLessThan(1e-3);
  });

  it("is null when the handle sits ON the pivot along every axis it drives", () => {
    // anchor at the bottom-right corner ⇒ that corner has no lever at all.
    const corner = { ...mediaLayer, anchorX: 1, anchorY: 1 };
    expect(solveScale(corner, "br", { x: 1, y: 1 }, layerPivot(corner), false)).toBeNull();
    expect(solveScale(corner, "br", { x: 1, y: 1 }, layerPivot(corner), true)).toBeNull();
    // Its neighbours still work — only the coincident handle is dead.
    expect(solveScale(corner, "tl", { x: 1, y: 1 }, layerPivot(corner), false)).not.toBeNull();
  });
});

describe("scaleCompensation", () => {
  it("re-centres a media layer so the PIVOT stays put, not the top-left", () => {
    // 200×100 doubled about its centre: the unrotated top-left has to move by
    // half the growth on each axis.
    expect(scaleCompensation(mediaLayer, 2, 2)).toEqual({ x: -100, y: -50 });
  });

  it("is ZERO for Text, whose x/y IS the pivot", () => {
    expect(scaleCompensation({ ...mediaLayer, origin: "anchor" }, 3, 0.5)).toEqual({ x: 0, y: 0 });
  });

  it("is ZERO for a top-left-anchored media layer, which scales from x/y anyway", () => {
    // `toBeCloseTo`, not `toEqual`: a zero pivot makes this literally `-0`,
    // which is still zero to the `!== 0` check that decides whether x/y is
    // written at all.
    const c = scaleCompensation({ ...mediaLayer, anchorX: 0, anchorY: 0 }, 4, 4);
    expect(c.x).toBeCloseTo(0, 12);
    expect(c.y).toBeCloseTo(0, 12);
  });

  it("ignores the sign, so a flipped layer compensates like an unflipped one", () => {
    // |S| and not S — the same rule anchorPivot.ts uses to mirror in place.
    expect(scaleCompensation({ ...mediaLayer, scaleX: -1 }, -2, 1)).toEqual({ x: -100, y: 0 });
  });

  it("has no rotation term at all", () => {
    for (const rotationDeg of [0, 37, 90, -145]) {
      expect(scaleCompensation({ ...mediaLayer, rotationDeg }, 2, 2)).toEqual({ x: -100, y: -50 });
    }
  });
});

describe("resize cursors", () => {
  const box = [
    { x: 0, y: 0 },
    { x: 320, y: 0 },
    { x: 320, y: 180 },
    { x: 0, y: 180 },
  ];

  it("points each handle away from the box", () => {
    expect(handleOutwardDeg(box, "br")).toBeCloseTo(45, 9);
    expect(handleOutwardDeg(box, "t")).toBeCloseTo(-90, 9);
    expect(handleOutwardDeg(box, "l")).toBeCloseTo(180, 9);
  });

  it("reads a corner as diagonal however wide the box is", () => {
    // Built from unit edge directions, not from (handle − centre) — which on
    // this 40:1 box would read the corner as almost horizontal.
    const wide = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(handleOutwardDeg(wide, "br")).toBeCloseTo(45, 9);
  });

  it("turns with the box, so a rotated layer swaps its diagonal cursors", () => {
    const turned = [
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 0, y: 0 },
    ];
    expect(resizeCursorForDeg(handleOutwardDeg(box, "br")!)).toBe("nwse-resize");
    expect(resizeCursorForDeg(handleOutwardDeg(turned, "br")!)).toBe("nesw-resize");
  });

  it("is null for a collapsed box rather than an arbitrary direction", () => {
    expect(handleOutwardDeg(Array.from({ length: 4 }, () => ({ x: 7, y: 9 })), "br")).toBeNull();
    expect(handleOutwardDeg(box.slice(0, 2), "br")).toBeNull();
  });

  it("maps each 45° octant to a cursor, and is 180°-symmetric", () => {
    expect(resizeCursorForDeg(0)).toBe("ew-resize");
    expect(resizeCursorForDeg(45)).toBe("nwse-resize");
    expect(resizeCursorForDeg(90)).toBe("ns-resize");
    expect(resizeCursorForDeg(135)).toBe("nesw-resize");
    for (const deg of [0, 45, 90, 135, 20, -170]) {
      expect(resizeCursorForDeg(deg + 180)).toBe(resizeCursorForDeg(deg));
    }
  });
});
