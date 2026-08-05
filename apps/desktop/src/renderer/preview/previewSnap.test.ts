import { describe, expect, it } from "vitest";

import {
  layerPivot,
  layerQuad,
  scaleCompensation,
  scaleFromUniformT,
  scaleHandlePoints,
  solveScale,
  uniformScaleRay,
  type LayerQuadInput,
  type ScaleHandleId,
} from "./gizmoGeometry";
import {
  quadAabb,
  snapMove,
  snapScaleTarget,
  snapTargets,
  snapThresholdComp,
  snapUniformScale,
  type Aabb,
} from "./previewSnap";

const COMP_W = 1920;
const COMP_H = 1080;

/// A 200×100 media layer near the top-left, unrotated. Same shape the
/// gizmoGeometry suite uses, so the two read as one story.
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

const compOnly = snapTargets(COMP_W, COMP_H, []);

/// Where the handle ACTUALLY lands once a solve's scale and its pivot-pinning
/// position fix are both applied — i.e. what the user sees, not what the solver
/// returned. The two D22/D23 claims are about this point, so every exactness
/// assertion below goes through it rather than through the scale pair.
function handleAfterSolve(
  frame: LayerQuadInput,
  id: ScaleHandleId,
  next: { scaleX: number; scaleY: number },
): { x: number; y: number } {
  const fix = scaleCompensation(frame, next.scaleX, next.scaleY);
  const after: LayerQuadInput = {
    ...frame,
    x: frame.x + fix.x,
    y: frame.y + fix.y,
    scaleX: next.scaleX,
    scaleY: next.scaleY,
  };
  const at = scaleHandlePoints(layerQuad(after))?.find((h) => h.id === id)?.at;
  if (!at) throw new Error("no handle");
  return at;
}

describe("quadAabb", () => {
  it("is the box itself when the layer is unrotated", () => {
    expect(quadAabb(layerQuad(mediaLayer))).toEqual({
      left: 100,
      top: 50,
      right: 300,
      bottom: 150,
    });
  });

  it("grows to contain a rotated layer's corners", () => {
    // 45° about the centre (200, 100): the half-diagonal is 150/√2 ≈ 106.07 each way.
    const box = quadAabb(layerQuad({ ...mediaLayer, rotationDeg: 45 }))!;
    expect(box.left).toBeCloseTo(200 - 150 / Math.SQRT2, 6);
    expect(box.right).toBeCloseTo(200 + 150 / Math.SQRT2, 6);
    // Wider than the unrotated 200 — the whole point of an AABB candidate.
    expect(box.right - box.left).toBeGreaterThan(200);
  });

  it("is winding-agnostic, so a flipped layer boxes the same range", () => {
    const box = quadAabb(layerQuad({ ...mediaLayer, scaleX: -1 }))!;
    expect(box.right).toBeGreaterThan(box.left);
    expect(box.bottom).toBeGreaterThan(box.top);
  });

  it("is null on a malformed quad", () => {
    expect(quadAabb([{ x: 0, y: 0 }])).toBeNull();
  });
});

describe("snapTargets", () => {
  it("offers the composition's edges and centre lines", () => {
    expect(compOnly.xs.map((t) => t.at)).toEqual([0, 960, 1920]);
    expect(compOnly.ys.map((t) => t.at)).toEqual([0, 540, 1080]);
    expect(compOnly.xs.every((t) => t.source === "composition")).toBe(true);
  });

  it("adds each other layer's edges and midpoint, tagged as a layer", () => {
    const other: Aabb = { left: 400, top: 200, right: 600, bottom: 400 };
    const targets = snapTargets(COMP_W, COMP_H, [other]);
    const layerXs = targets.xs.filter((t) => t.source === "layer").map((t) => t.at);
    expect(layerXs).toEqual([400, 500, 600]);
    const layerYs = targets.ys.filter((t) => t.source === "layer").map((t) => t.at);
    expect(layerYs).toEqual([200, 300, 400]);
  });
});

describe("snapThresholdComp", () => {
  it("converts screen pixels to composition pixels through the contain fit", () => {
    // A 4K source in a panel showing it at half size: 12 screen px is 24 comp px.
    expect(snapThresholdComp(12, 0.5)).toBe(24);
    // Panel larger than the composition — the threshold shrinks, as it must.
    expect(snapThresholdComp(12, 2)).toBe(6);
  });

  it("disables snapping on a degenerate fit rather than returning Infinity", () => {
    expect(snapThresholdComp(12, 0)).toBe(0);
    expect(snapThresholdComp(12, Number.NaN)).toBe(0);
  });
});

describe("snapMove", () => {
  const boxAt = (left: number, top: number): Aabb => ({
    left,
    top,
    right: left + 200,
    bottom: top + 100,
  });

  it("snaps both axes at once — flush left AND vertically centred", () => {
    // Left edge 5 px from x=0; box centre 5 px from y=540.
    const r = snapMove(boxAt(5, 485), compOnly, 12);
    expect(r.dx).toBe(-5);
    expect(r.dy).toBe(5);
    expect(r.guides).toEqual({ x: 0, y: 540 });
  });

  it("leaves an axis alone when only the other one is in range", () => {
    const r = snapMove(boxAt(5, 700), compOnly, 12);
    expect(r.dx).toBe(-5);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual({ x: 0, y: null });
  });

  it("does not snap past the threshold", () => {
    const r = snapMove(boxAt(20, 700), compOnly, 12);
    expect(r).toEqual({ dx: 0, dy: 0, guides: { x: null, y: null } });
  });

  it("snaps the box's far edge, not just its near one", () => {
    // Right edge (left+200) 4 px short of the composition's right edge.
    const r = snapMove(boxAt(COMP_W - 204, 700), compOnly, 12);
    expect(r.dx).toBe(4);
    expect(r.guides.x).toBe(COMP_W);
  });

  it("breaks a tie toward the composition line", () => {
    // A layer line exactly as far from the box's left edge as x=0 is.
    const targets = snapTargets(COMP_W, COMP_H, [
      { left: 16, top: 900, right: 116, bottom: 1000 },
    ]);
    const r = snapMove(boxAt(8, 700), targets, 12);
    expect(r.guides.x).toBe(0);
    expect(r.dx).toBe(-8);
  });

  it("lets a layer line win when it is strictly nearer", () => {
    const targets = snapTargets(COMP_W, COMP_H, [
      { left: 12, top: 900, right: 112, bottom: 1000 },
    ]);
    const r = snapMove(boxAt(8, 700), targets, 12);
    expect(r.guides.x).toBe(12);
    expect(r.dx).toBe(4);
  });

  it("is tie-break stable regardless of target order", () => {
    // Same distance from two layer boxes on either side; the composition's own
    // line is equidistant too and must win from whichever position it occupies.
    const targets = snapTargets(COMP_W, COMP_H, [
      { left: -6, top: 900, right: 94, bottom: 1000 },
      { left: 6, top: 900, right: 106, bottom: 1000 },
    ]);
    expect(snapMove(boxAt(0, 700), targets, 12).guides.x).toBe(0);
  });

  it("does nothing at a zero threshold — the off switch and Ctrl share it", () => {
    const r = snapMove(boxAt(2, 538), compOnly, 0);
    expect(r).toEqual({ dx: 0, dy: 0, guides: { x: null, y: null } });
  });

  it("uses a rotated layer's AABB, so its leftmost CORNER is what snaps", () => {
    // Rotated 45° and nudged so the AABB's left edge sits 3 px inside the frame.
    const rotated = { ...mediaLayer, rotationDeg: 45 };
    const box = quadAabb(layerQuad(rotated))!;
    const shifted: Aabb = {
      left: 3,
      top: box.top,
      right: 3 + (box.right - box.left),
      bottom: box.bottom,
    };
    const r = snapMove(shifted, compOnly, 12);
    expect(r.dx).toBe(-3);
    // The un-rotated content's left edge is NOT where the snap happened — it is
    // inset from the AABB by the rotation.
    expect(box.right - box.left).toBeGreaterThan(mediaLayer.naturalW);
  });
});

describe("snapScaleTarget", () => {
  it("masks off an axis the handle does not drive", () => {
    // An `r` handle drives x only. A horizontal target 2 px away must be ignored:
    // solveScale would discard it, so drawing a guide for it would be a lie.
    const r = snapScaleTarget({ x: 1918, y: 538 }, { x: true, y: false }, compOnly, 12);
    expect(r.target.x).toBe(COMP_W);
    expect(r.target.y).toBe(538);
    expect(r.guides).toEqual({ x: COMP_W, y: null });
  });

  it("snaps both axes for a corner handle", () => {
    const r = snapScaleTarget({ x: 1916, y: 1076 }, { x: true, y: true }, compOnly, 12);
    expect(r.target).toEqual({ x: COMP_W, y: COMP_H });
    expect(r.guides).toEqual({ x: COMP_W, y: COMP_H });
  });

  it("puts the handle EXACTLY on the snapped point, unrotated", () => {
    const frame = { ...mediaLayer, x: 1600, y: 900 };
    const pivot = layerPivot(frame);
    const raw = { x: 1916, y: 1076 };
    const snapped = snapScaleTarget(raw, { x: true, y: true }, compOnly, 12).target;
    const next = solveScale(frame, "br", snapped, pivot, false)!;
    const landed = handleAfterSolve(frame, "br", next);
    expect(landed.x).toBeCloseTo(COMP_W, 6);
    expect(landed.y).toBeCloseTo(COMP_H, 6);
  });

  it("puts the handle EXACTLY on the snapped point at an awkward rotation", () => {
    // The identity P + R·(S₁·u) = target holds at any angle — this is the case
    // that looks like it should need a correction and does not.
    const frame = { ...mediaLayer, x: 1500, y: 800, rotationDeg: 37 };
    const pivot = layerPivot(frame);
    const snapped = snapScaleTarget(
      { x: 1914, y: 1073 },
      { x: true, y: true },
      compOnly,
      12,
    ).target;
    const next = solveScale(frame, "br", snapped, pivot, false)!;
    const landed = handleAfterSolve(frame, "br", next);
    expect(landed.x).toBeCloseTo(COMP_W, 6);
    expect(landed.y).toBeCloseTo(COMP_H, 6);
  });

  it("leaves the point untouched at a zero threshold", () => {
    const raw = { x: 1919, y: 1079 };
    const r = snapScaleTarget(raw, { x: true, y: true }, compOnly, 0);
    expect(r.target).toEqual(raw);
    expect(r.guides).toEqual({ x: null, y: null });
  });
});

describe("snapUniformScale", () => {
  /// A linked layer whose `br` handle is heading for the bottom-right corner.
  const linkedFrame: LayerQuadInput = { ...mediaLayer, x: 1500, y: 800 };

  it("lands the handle exactly on the line it drew a guide for", () => {
    const pivot = layerPivot(linkedFrame);
    const ray = uniformScaleRay(linkedFrame, "br");
    const raw = solveScale(linkedFrame, "br", { x: 1914, y: 1070 }, pivot, true)!;
    const snapped = snapUniformScale(
      pivot,
      ray,
      raw.uniformT!,
      { x: true, y: true },
      compOnly,
      40,
    );
    expect(snapped.t).not.toBe(raw.uniformT);
    const landed = handleAfterSolve(
      linkedFrame,
      "br",
      scaleFromUniformT(linkedFrame, snapped.t),
    );
    if (snapped.guides.x !== null) expect(landed.x).toBeCloseTo(snapped.guides.x, 6);
    else expect(landed.y).toBeCloseTo(snapped.guides.y!, 6);
  });

  it("hits at most ONE axis — one parameter cannot satisfy two equations", () => {
    const pivot = layerPivot(linkedFrame);
    const ray = uniformScaleRay(linkedFrame, "br");
    const r = snapUniformScale(pivot, ray, 1, { x: true, y: true }, compOnly, 400);
    const hits = (r.guides.x === null ? 0 : 1) + (r.guides.y === null ? 0 : 1);
    expect(hits).toBe(1);
  });

  it("refuses a near-parallel ray, because the DISPLACEMENT blows past the threshold", () => {
    // The ray barely moves on x, so reaching a vertical line 5 comp px away
    // needs a ~500× change in t. Measuring the perpendicular distance would
    // accept this; measuring the displacement rejects it.
    const pivot = { x: 100, y: 100 };
    const ray = { x: 0.01, y: 100 };
    const targets = snapTargets(COMP_W, COMP_H, [
      { left: 105, top: 5000, right: 105, bottom: 5000 },
    ]);
    const r = snapUniformScale(pivot, ray, 1, { x: true, y: false }, targets, 12);
    expect(r.t).toBe(1);
    expect(r.guides).toEqual({ x: null, y: null });
  });

  it("skips an axis the ray does not move along at all", () => {
    // A zero component makes t infinite (or NaN when the numerator is zero too);
    // both must drop out rather than produce a scale.
    const r = snapUniformScale(
      { x: 0, y: 100 },
      { x: 0, y: 50 },
      1,
      { x: true, y: false },
      compOnly,
      12,
    );
    expect(r.t).toBe(1);
    expect(Number.isFinite(r.t)).toBe(true);
    expect(r.guides).toEqual({ x: null, y: null });
  });

  it("respects the driven-axis mask", () => {
    const pivot = { x: 960, y: 100 };
    // The ray heads straight down; y is in easy reach of the centre line but the
    // handle does not drive y.
    const r = snapUniformScale(pivot, { x: 0, y: 400 }, 1.1, { x: false, y: false }, compOnly, 80);
    expect(r.t).toBe(1.1);
  });

  it("returns the raw factor at a zero threshold", () => {
    const r = snapUniformScale({ x: 0, y: 0 }, { x: 100, y: 100 }, 1.5, { x: true, y: true }, compOnly, 0);
    expect(r.t).toBe(1.5);
    expect(r.guides).toEqual({ x: null, y: null });
  });

  it("returns the raw factor when the ray has no length", () => {
    const r = snapUniformScale({ x: 0, y: 0 }, { x: 0, y: 0 }, 1.5, { x: true, y: true }, compOnly, 12);
    expect(r.t).toBe(1.5);
  });
});
