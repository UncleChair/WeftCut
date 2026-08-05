// Where a layer's footprint lands on screen. Pure — no renderer, no DOM: the
// on-canvas gizmo's geometry is unit-testable, and preview and gizmo can't
// disagree because both derive from the same transform rule
// (`render/anchorPivot.ts`).
//
// Two coordinate systems, in order:
//   layer local → COMPOSITION pixels   (transform: pivot, scale, rotation)
//   composition → CLIENT pixels        (the canvas' object-fit: contain box)
// Spec: docs/features.md#on-canvas-transform-gizmo

import { anchorOr, anchorPivot } from "../render/anchorPivot";

export interface Pt {
  x: number;
  y: number;
}

/// Which point `x`/`y` names — the kind asymmetry documented in
/// docs/data-model.md#transform. Media kinds store the unrotated top-left;
/// Text stores the anchor point itself.
export type TransformOrigin = "top-left" | "anchor";

export interface LayerQuadInput {
  x: number;
  y: number;
  /// Coalesced through `anchorOr` — the SAME default the renderer uses, so the
  /// box can't pivot somewhere the picture doesn't.
  anchorX: number | undefined;
  anchorY: number | undefined;
  /// Untransformed content size in composition pixels (media dimensions for a
  /// VideoClip, raster/texture dimensions otherwise).
  naturalW: number;
  naturalH: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  origin: TransformOrigin;
}

/// The transform frame a box and its handles share: where the content's local
/// rect starts, the pivot inside it, and local → composition. One function so a
/// handle can never pivot somewhere the box doesn't turn about.
function quadFrame(i: LayerQuadInput): {
  left: number;
  top: number;
  pivotX: number;
  pivotY: number;
  map: (lx: number, ly: number) => Pt;
} {
  const { naturalW: w, naturalH: h } = i;
  // Anchor origin: the content hangs off the anchor point, so its local rect
  // starts at −anchor·size and the pivot is already at (0,0) — exactly how
  // Pixi's `anchor` behaves for Text. Top-left origin: the pivot sits at the
  // anchor and the position compensates for it (anchorPivot.ts).
  const anchored = i.origin === "anchor";
  const p = anchored
    ? { pivotX: 0, pivotY: 0, posX: i.x, posY: i.y }
    : anchorPivot({
        x: i.x,
        y: i.y,
        anchorX: i.anchorX,
        anchorY: i.anchorY,
        texW: w,
        texH: h,
        effScaleX: i.scaleX,
        effScaleY: i.scaleY,
      });
  const rad = (i.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    left: anchored ? -anchorOr(i.anchorX) * w : 0,
    top: anchored ? -anchorOr(i.anchorY) * h : 0,
    pivotX: p.pivotX,
    pivotY: p.pivotY,
    map: (lx: number, ly: number): Pt => {
      const dx = (lx - p.pivotX) * i.scaleX;
      const dy = (ly - p.pivotY) * i.scaleY;
      return { x: p.posX + dx * cos - dy * sin, y: p.posY + dx * sin + dy * cos };
    },
  };
}

/// The four corners in composition space, in TL, TR, BR, BL order of the
/// UNROTATED content (so a rotated quad's first point is still the content's
/// own top-left, which is what a handle would have to grab).
export function layerQuad(i: LayerQuadInput): [Pt, Pt, Pt, Pt] {
  const { naturalW: w, naturalH: h } = i;
  const { left: l, top: t, map } = quadFrame(i);
  return [map(l, t), map(l + w, t), map(l + w, t + h), map(l, t + h)];
}

/// The point the engine rotates and scales the layer about, in composition
/// pixels — i.e. the only correct centre for a rotation gesture. Falls out of
/// the same frame as the box: mapping the pivot through the transform IS the
/// transform's position, so this is exact for a flipped or non-uniformly
/// scaled layer too.
export function layerPivot(i: LayerQuadInput): Pt {
  const f = quadFrame(i);
  return f.map(f.pivotX, f.pivotY);
}

/// A composition-space movement expressed in the layer's own LOCAL pixels — the
/// inverse of `quadFrame`'s `map` for deltas (`d = R·S·localDelta`, so
/// `localDelta = S⁻¹·R⁻¹·d`). Null when a scale axis is 0: a layer flattened on
/// one axis has no local extent there to move an anchor along, and dividing
/// would hand back Infinity.
///
/// This is what makes an anchor drag track the cursor: the anchor is stored in
/// UNROTATED, UNSCALED normalized units, so a screen-space gesture has to be
/// un-rotated and un-scaled before it means anything as an anchor delta.
export function compDeltaToLocal(d: Pt, i: LayerQuadInput): Pt | null {
  if (i.scaleX === 0 || i.scaleY === 0 || !Number.isFinite(i.scaleX) || !Number.isFinite(i.scaleY)) {
    return null;
  }
  // Negative angle = the inverse rotation.
  const rad = (-i.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: (d.x * cos - d.y * sin) / i.scaleX,
    y: (d.x * sin + d.y * cos) / i.scaleY,
  };
}

/// The `x`/`y` change that holds the PICTURE still while the anchor moves by
/// `(dAnchorX, dAnchorY)` — i.e. what makes an on-canvas anchor drag behave like
/// After Effects' pan-behind tool instead of swinging the layer.
///
/// Moving the anchor moves the pivot, and the pivot enters the composed position
/// twice. Writing `q = (dAnchorX·naturalW, dAnchorY·naturalH)` for the pivot
/// change in local pixels, the content's placement shifts by:
///
///   anchor origin (Text)   −R·S·q          (the local rect starts at −anchor·size)
///   top-left origin (media) |S|·q − R·S·q  (position also adds pivot·|scale| back)
///
/// so the compensation is the negation of each. Two consequences worth knowing:
/// at `rotation_deg = 0` with no flip the media case is exactly ZERO — the pivot
/// moves and nothing else does — while Text ALWAYS needs compensation, because
/// its `x`/`y` IS the anchor point and the glyphs hang off it.
export function anchorCompensation(i: LayerQuadInput, dAnchorX: number, dAnchorY: number): Pt {
  const qx = dAnchorX * i.naturalW;
  const qy = dAnchorY * i.naturalH;
  const rad = (i.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = qx * i.scaleX;
  const sy = qy * i.scaleY;
  // R·S·q — the term both origins share.
  const rx = sx * cos - sy * sin;
  const ry = sx * sin + sy * cos;
  if (i.origin === "anchor") return { x: rx, y: ry };
  return { x: rx - qx * Math.abs(i.scaleX), y: ry - qy * Math.abs(i.scaleY) };
}

/// The `x`/`y` change that holds the PIVOT still while the scale goes from the
/// frame's `scaleX`/`scaleY` to `(nextScaleX, nextScaleY)` — what makes a resize
/// handle scale about the anchor the way After Effects and Premiere do, instead
/// of about the unrotated top-left (which is what writing scale alone does).
///
/// It falls out of `anchorPivot.ts` in one line: the pivot lands at
/// `pos = (x, y) + |S|·p`, so pinning it is `Δ = p·(|S₀| − |S₁|)`. Note there is
/// NO rotation term — `pos` never had one — which is why this compensation, unlike
/// the anchor drag's, is exact at any angle without a frozen-time caveat on
/// rotation. `|S|` and not `S` for the same reason as everywhere else in that
/// module: a flip must mirror the content in place rather than move the pivot.
///
/// The mirror image of `anchorCompensation`: there the media kinds usually needed
/// nothing and Text always did. Here Text needs NOTHING (its `pos` is `x`/`y`
/// outright, so scale cannot move it) and a media layer always does, unless its
/// anchor sits on the top-left corner it scales from anyway.
export function scaleCompensation(i: LayerQuadInput, nextScaleX: number, nextScaleY: number): Pt {
  if (i.origin === "anchor") return { x: 0, y: 0 };
  return {
    x: anchorOr(i.anchorX) * i.naturalW * (Math.abs(i.scaleX) - Math.abs(nextScaleX)),
    y: anchorOr(i.anchorY) * i.naturalH * (Math.abs(i.scaleY) - Math.abs(nextScaleY)),
  };
}

/// The `object-fit: contain` placement of a composition inside a client box —
/// the FORWARD direction of `colorpick/pixel.ts` `containMap`. Null when the
/// box or the composition is degenerate (zero-sized panel, no project).
export interface ContainFit {
  scale: number;
  offX: number;
  offY: number;
}

export function containFit(
  rect: { left: number; top: number; width: number; height: number },
  compW: number,
  compH: number,
): ContainFit | null {
  if (compW <= 0 || compH <= 0) return null;
  const scale = Math.min(rect.width / compW, rect.height / compH);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    scale,
    offX: rect.left + (rect.width - compW * scale) / 2,
    offY: rect.top + (rect.height - compH * scale) / 2,
  };
}

export function compToClient(p: Pt, fit: ContainFit): Pt {
  return { x: fit.offX + p.x * fit.scale, y: fit.offY + p.y * fit.scale };
}

/// A pointer movement in client pixels expressed in composition pixels — the
/// only conversion a move drag needs. LANDMINE: divide, don't multiply; the
/// panel is usually SMALLER than the composition, so a 10 px drag on a 4K
/// preview is ~30 composition pixels.
export function clientDeltaToComp(dxClient: number, dyClient: number, fit: ContainFit): Pt {
  return { x: dxClient / fit.scale, y: dyClient / fit.scale };
}

export interface RotateHandle {
  /// Where the stalk leaves the box: the midpoint of the content's top edge.
  root: Pt;
  /// The knob, `gap` px beyond the root along the box's own "up".
  knob: Pt;
}

const EPS = 1e-6;

function midpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/// Where the rotation knob sits for an already-mapped box. Takes SCREEN-space
/// corners and a screen-space `gap` on purpose: the knob has to stay the same
/// grabbable size whether the layer fills a 4K composition or is 20 px wide in
/// the panel — the whole reason the gizmo is an overlay and not Pixi children.
///
/// The direction is bottom-mid → top-mid rather than a perpendicular of the top
/// edge, so the stalk always leaves the box on the side away from its body,
/// including when a negative scale reverses the quad's winding.
export function rotateHandle(quad: readonly Pt[], gap: number): RotateHandle | null {
  const [tl, tr, br, bl] = quad;
  if (!tl || !tr || !br || !bl) return null;
  const root = midpoint(tl, tr);
  const foot = midpoint(bl, br);
  let ux = root.x - foot.x;
  let uy = root.y - foot.y;
  let len = Math.hypot(ux, uy);
  if (len < EPS) {
    // Zero-height box (a layer scaled flat): the body has no side, so fall back
    // to the top edge's perpendicular, then to straight up.
    ux = tr.y - tl.y;
    uy = -(tr.x - tl.x);
    len = Math.hypot(ux, uy);
  }
  if (len < EPS) return { root, knob: { x: root.x, y: root.y - gap } };
  return { root, knob: { x: root.x + (ux / len) * gap, y: root.y + (uy / len) * gap } };
}

/// The angle of `p` seen from `center`, in degrees. Screen y grows downward, so
/// a positive angle turns clockwise — the same direction `rotation_deg` turns
/// the picture, which is what lets a rotate drag be a plain angle difference.
export function angleAboutDeg(center: Pt, p: Pt): number {
  return (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
}

/// Fold a raw angle difference into (−180, 180]. LANDMINE: `atan2` has a branch
/// cut at ±180°, so a gesture crossing it yields −340° where the user moved
/// +20°. Apply this per pointermove and ACCUMULATE, never diff against the
/// gesture's start angle — accumulating is also what makes dragging the knob
/// twice around mean two turns instead of snapping back.
export function shortestDeltaDeg(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/// Snap the RESULTING angle (not the delta) to a multiple of `step`, so a
/// Shift-held drag lands on an absolute 0/15/30… grid the way every other
/// tool's constrained rotate behaves.
export function snapAngleDeg(deg: number, step: number): number {
  return step > 0 ? Math.round(deg / step) * step : deg;
}

/// The eight resize handles, named on the CONTENT's own frame: a layer rotated
/// 90° still grabs its own `tl` at what the screen shows as top-right.
export type ScaleHandleId = "t" | "r" | "b" | "l" | "tl" | "tr" | "br" | "bl";

/// Document order, and therefore hit order — SVG hit-tests the topmost painted
/// element, so the CORNERS come last and win wherever a shrunken box makes them
/// overlap an edge handle.
export const SCALE_HANDLE_IDS: readonly ScaleHandleId[] = [
  "t",
  "r",
  "b",
  "l",
  "tl",
  "tr",
  "br",
  "bl",
];

/// The four that survive on a `scale_linked` layer. A linked layer genuinely
/// cannot be scaled on one axis — a single-axis write is what the main-side twin
/// invariant reads as divergence, so an edge handle would either lie about what
/// it does or silently unlink the layer (docs/data-model.md#transform). The
/// affordance itself carries the constraint.
export const CORNER_HANDLE_IDS: readonly ScaleHandleId[] = ["tl", "tr", "br", "bl"];

const CORNERS = new Set<ScaleHandleId>(CORNER_HANDLE_IDS);

export function isCornerHandle(id: ScaleHandleId): boolean {
  return CORNERS.has(id);
}

/// Where each handle sits on the content rect, as a signed direction from its
/// centre. LANDMINE: `0` marks the axis the handle does NOT drive, and that has
/// to come from the handle's identity rather than from "its offset happens to be
/// zero" — an off-centre anchor gives the top edge's midpoint a non-zero x
/// offset from the pivot, and deriving the mask from the offset would let a
/// vertical drag scale the layer sideways.
const HANDLE_DIR: Record<ScaleHandleId, { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }> = {
  t: { hx: 0, hy: -1 },
  r: { hx: 1, hy: 0 },
  b: { hx: 0, hy: 1 },
  l: { hx: -1, hy: 0 },
  tl: { hx: -1, hy: -1 },
  tr: { hx: 1, hy: -1 },
  br: { hx: 1, hy: 1 },
  bl: { hx: -1, hy: 1 },
};

/// 0 → the rect's low edge, 1 → its high edge, 0.5 → the midpoint.
function unitFrac(h: -1 | 0 | 1): number {
  return (h + 1) / 2;
}

/// Which axes the handle drives, straight off `HANDLE_DIR`. Exported because
/// snapping needs the same mask the solve uses: `solveScale` returns the frame's
/// own scale unchanged on an undriven axis, so a snap offered there would be
/// computed, drawn as a guide, and then silently discarded. Deriving it a second
/// time at the call site is exactly the duplication the LANDMINE above warns
/// about — an off-centre anchor makes a zero offset a lie.
export function handleDrives(id: ScaleHandleId): { x: boolean; y: boolean } {
  const d = HANDLE_DIR[id];
  return { x: d.hx !== 0, y: d.hy !== 0 };
}

/// Every handle's position for an already-mapped box, by bilinear interpolation
/// of the quad — so corners and edge midpoints come out of one expression and a
/// rotated, flipped or non-uniformly scaled box needs no special case. SCREEN
/// space in, screen space out, like `rotateHandle`.
export function scaleHandlePoints(quad: readonly Pt[]): Array<{ id: ScaleHandleId; at: Pt }> | null {
  const [tl, tr, br, bl] = quad;
  if (!tl || !tr || !br || !bl) return null;
  return SCALE_HANDLE_IDS.map((id) => {
    const d = HANDLE_DIR[id];
    const u = unitFrac(d.hx);
    const v = unitFrac(d.hy);
    return {
      id,
      at: {
        x: tl.x * (1 - u) * (1 - v) + tr.x * u * (1 - v) + br.x * u * v + bl.x * (1 - u) * v,
        y: tl.y * (1 - u) * (1 - v) + tr.y * u * (1 - v) + br.y * u * v + bl.y * (1 - u) * v,
      },
    };
  });
}

/// The handle's offset from the PIVOT in the layer's own LOCAL pixels — the `u`
/// a scale solve divides the cursor by. Independent of the origin convention by
/// construction: for both, it works out to `(frac − anchor)·size`, because the
/// top-left origin puts the pivot at the anchor while the anchor origin moves
/// the rect instead.
export function scaleHandleOffset(i: LayerQuadInput, id: ScaleHandleId): Pt {
  const f = quadFrame(i);
  const d = HANDLE_DIR[id];
  return {
    x: f.left + unitFrac(d.hx) * i.naturalW - f.pivotX,
    y: f.top + unitFrac(d.hy) * i.naturalH - f.pivotY,
  };
}

/// Never let a solve land a layer on exactly 0: at zero scale the box collapses
/// to a point, every handle stacks on the pivot and the gesture that got it
/// there can't get it back. Sub-pixel on any composition, so it is invisible.
const MIN_SCALE = 1e-4;

function clampScale(s: number): number {
  if (!Number.isFinite(s)) return MIN_SCALE;
  return Math.abs(s) < MIN_SCALE ? (s < 0 ? -MIN_SCALE : MIN_SCALE) : s;
}

/// The scale pair that puts `handle` under `targetComp` while the PIVOT stays at
/// `pivotComp` — i.e. an After Effects / Premiere resize, not a Figma one.
///
/// Pinning the pivot is what makes this a one-liner per axis. The composed
/// position of a local point is `P + R·S·u`, so with `P` held still the whole
/// solve is `S·u = R⁻¹·(cursor − P)`: un-rotate the cursor, divide by the
/// handle's local offset. Exact for a rotated, flipped or non-uniformly scaled
/// layer, and it needs no iteration.
///
/// `uniform` (a linked layer, or Shift) fits ONE factor `t` with `S = t·S₀`
/// instead, by least squares over the handle's own axes — which is the diagonal
/// projection on a corner and the plain axis ratio on an edge, from one formula.
///
/// Null when the handle has collapsed onto the pivot along every axis it drives:
/// there is no lever left to scale by, and dividing would hand back Infinity.
///
/// `uniformT` is the fitted factor, present only on the uniform path. Returned
/// rather than left implicit because snapping needs it
/// (`previewSnap.snapUniformScale`) and recovering it from the result would mean
/// dividing by `frame.scaleX`, which a user is free to have set to 0.
export function solveScale(
  frame: LayerQuadInput,
  id: ScaleHandleId,
  targetComp: Pt,
  pivotComp: Pt,
  uniform: boolean,
): { scaleX: number; scaleY: number; uniformT?: number } | null {
  const u = scaleHandleOffset(frame, id);
  const d = HANDLE_DIR[id];
  // R⁻¹·(cursor − pivot): the cursor in the layer's own unrotated frame.
  const rad = (-frame.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = targetComp.x - pivotComp.x;
  const dy = targetComp.y - pivotComp.y;
  const v = { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  if (uniform) {
    // Masked so an edge handle projects onto its own axis alone; b = S₀·u is
    // where the handle sits before the gesture, so t is "how far along its own
    // diagonal the cursor is".
    const bx = d.hx !== 0 ? frame.scaleX * u.x : 0;
    const by = d.hy !== 0 ? frame.scaleY * u.y : 0;
    const denom = bx * bx + by * by;
    if (denom < EPS) return null;
    const t = (bx * v.x + by * v.y) / denom;
    return { ...scaleFromUniformT(frame, t), uniformT: t };
  }
  const drivesX = d.hx !== 0 && Math.abs(u.x) > EPS;
  const drivesY = d.hy !== 0 && Math.abs(u.y) > EPS;
  if (!drivesX && !drivesY) return null;
  return {
    scaleX: drivesX ? clampScale(v.x / u.x) : frame.scaleX,
    scaleY: drivesY ? clampScale(v.y / u.y) : frame.scaleY,
  };
}

/// The scale pair a uniform factor means, floored the same way a solve's is.
/// The one place `S = t·S₀` is written, so a snapped `t` (previewSnap.ts) and a
/// fitted one cannot land on different scales for the same factor.
export function scaleFromUniformT(
  frame: LayerQuadInput,
  t: number,
): { scaleX: number; scaleY: number } {
  return { scaleX: clampScale(t * frame.scaleX), scaleY: clampScale(t * frame.scaleY) };
}

/// The direction the handle travels per unit uniform `t`: `R·S₀·u`, in
/// composition pixels. NOT masked by the handle's driven axes — the mask decides
/// which axes the least-squares fit listens to, while the handle's motion is the
/// full transform of its offset, and snapping needs the motion.
export function uniformScaleRay(frame: LayerQuadInput, id: ScaleHandleId): Pt {
  const u = scaleHandleOffset(frame, id);
  const sx = u.x * frame.scaleX;
  const sy = u.y * frame.scaleY;
  const rad = (frame.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: sx * cos - sy * sin, y: sx * sin + sy * cos };
}

function unit(p: Pt): Pt | null {
  const len = Math.hypot(p.x, p.y);
  return len < EPS ? null : { x: p.x / len, y: p.y / len };
}

/// Which way the handle points AWAY from the box, on screen, in degrees — the
/// input a resize cursor is chosen from.
///
/// Built from the box's own unit edge directions rather than from
/// (handle − centre): the latter reads a corner of a very wide box as almost
/// horizontal and would show it an `ew` cursor. Going through the unit axes also
/// makes it mirror-aware for free — a negative scale flips one axis, and a
/// corner's cursor genuinely does swap diagonals when the box is mirrored.
export function handleOutwardDeg(quad: readonly Pt[], id: ScaleHandleId): number | null {
  const [tl, tr, , bl] = quad;
  if (!tl || !tr || !bl) return null;
  const ax = unit({ x: tr.x - tl.x, y: tr.y - tl.y });
  const ay = unit({ x: bl.x - tl.x, y: bl.y - tl.y });
  if (!ax || !ay) return null;
  const d = HANDLE_DIR[id];
  const x = d.hx * ax.x + d.hy * ay.x;
  const y = d.hx * ax.y + d.hy * ay.y;
  if (Math.hypot(x, y) < EPS) return null;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/// The four diagonal-aware resize cursors, indexed by 45° octant. The set is
/// 180°-symmetric (a cursor is a double-headed arrow), so four entries cover the
/// full turn.
const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/// The CSS cursor for a handle pointing at `deg`, so a rotated layer's handles
/// still read as "drag this way" instead of showing the unrotated box's cursors.
export function resizeCursorForDeg(deg: number): string {
  const norm = (((deg % 360) + 360) % 360) / 45;
  return RESIZE_CURSORS[Math.round(norm) % 4]!;
}
