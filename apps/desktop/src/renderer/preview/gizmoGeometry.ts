// Where a layer's footprint lands on screen. Pure — no renderer, no DOM: the
// on-canvas gizmo's geometry is unit-testable, and preview and gizmo can't
// disagree because both derive from the same transform rule
// (`render/anchorPivot.ts`).
//
// Two coordinate systems, in order:
//   layer local → COMPOSITION pixels   (transform: pivot, scale, rotation)
//   composition → CLIENT pixels        (the canvas' object-fit: contain box)
// Spec: .scratch/preview-gizmo/spec.md (D4)

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
