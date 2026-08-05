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

/// The four corners in composition space, in TL, TR, BR, BL order of the
/// UNROTATED content (so a rotated quad's first point is still the content's
/// own top-left, which is what a handle would have to grab).
export function layerQuad(i: LayerQuadInput): [Pt, Pt, Pt, Pt] {
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
  const l = anchored ? -anchorOr(i.anchorX) * w : 0;
  const t = anchored ? -anchorOr(i.anchorY) * h : 0;
  const rad = (i.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const map = (lx: number, ly: number): Pt => {
    const dx = (lx - p.pivotX) * i.scaleX;
    const dy = (ly - p.pivotY) * i.scaleY;
    return { x: p.posX + dx * cos - dy * sin, y: p.posY + dx * sin + dy * cos };
  };
  return [map(l, t), map(l + w, t), map(l + w, t + h), map(l, t + h)];
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
