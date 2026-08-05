// `Transform.anchor` → the Pixi pivot + the position that keeps `x`/`y`
// meaning what stored projects already mean by it. Pure: the one place the
// rule lives, so the three media kinds can't drift apart.
// Rule: docs/data-model.md#transform

/// Pixi composes `world = position + R·S·(local − pivot)`, so putting the
/// pivot at the anchor makes rotation and flip turn around the anchor — but it
/// also drags the content by `pivot·scale` unless the position compensates.
/// Compensating with the ABSOLUTE scale is what makes a flip mirror in place:
/// with the signed scale the anchor itself would move, and the layer would jump
/// to the other side of `x`.
///
/// Consequence worth stating: at `rotation_deg = 0` with no flip, local (0,0)
/// lands exactly on `(x, y)` for ANY scale. That is what keeps `x`/`y` meaning
/// the unrotated top-left; only a rotated or flipped layer sees the pivot at all.
export interface AnchorPivotInput {
  /// Layer transform, composition pixels — the unrotated top-left.
  x: number;
  y: number;
  /// Normalized pivot, `(0.5, 0.5)` = center. Optional-at-runtime on purpose:
  /// see `anchorOr`.
  anchorX: number | undefined;
  anchorY: number | undefined;
  /// Natural (texture) dimensions in LOCAL space. Null/0 before the first
  /// frame binds (`Texture.EMPTY`) ⇒ pivot 0, so the sprite still lands at
  /// `(x, y)` instead of NaN.
  texW: number | null;
  texH: number | null;
  /// The scale the sprite actually renders at, INCLUDING any source-vs-proxy
  /// correction. Sign is ignored (see above) — pass it signed or not.
  effScaleX: number;
  effScaleY: number;
}

export interface AnchorPivotResult {
  pivotX: number;
  pivotY: number;
  posX: number;
  posY: number;
}

/// The stored default — `defaultTransform()` writes `[0.5, 0.5]` and every
/// production Transform producer goes through it.
export const DEFAULT_ANCHOR = 0.5;

/// THE one place an absent/garbage anchor is coalesced, and it must stay the
/// one place. LANDMINE: the wire type declares `anchor_x` required, so a missing
/// value means a version skew (a renderer newer than the main process it talks
/// to). Coalescing it to 0 "because it's missing" is the worst answer available:
/// the renderer would pivot at the top-left while the on-canvas box — which
/// derives from this same module — pivots at the center, so the box and the
/// picture would rotate around different points and neither would look broken
/// on its own.
export function anchorOr(anchor: number | undefined): number {
  return typeof anchor === "number" && Number.isFinite(anchor) ? anchor : DEFAULT_ANCHOR;
}

function pivotAxis(anchor: number | undefined, tex: number | null): number {
  if (tex === null || !Number.isFinite(tex) || tex <= 0) return 0;
  return anchorOr(anchor) * tex;
}

function positionAxis(coord: number, pivot: number, effScale: number): number {
  const s = Number.isFinite(effScale) ? Math.abs(effScale) : 0;
  return coord + pivot * s;
}

/// Spread-in helper for the sprite call sites: a texture's local extent as the
/// `texW`/`texH` pair. Structurally typed on purpose — this module stays
/// renderer-free so the geometry can be unit-tested without Pixi.
///
/// No `Texture.EMPTY` special case: the kinds that use it (ImageOverlay, Motif)
/// report `stageReady === false` while EMPTY and are never staged, and the
/// Compositor's VideoClip branch passes its own null-for-EMPTY pair instead.
export function textureExtent(texture: {
  orig: { width: number; height: number };
}): { texW: number; texH: number } {
  return { texW: texture.orig.width, texH: texture.orig.height };
}

export function anchorPivot(i: AnchorPivotInput): AnchorPivotResult {
  const pivotX = pivotAxis(i.anchorX, i.texW);
  const pivotY = pivotAxis(i.anchorY, i.texH);
  return {
    pivotX,
    pivotY,
    posX: positionAxis(i.x, pivotX, i.effScaleX),
    posY: positionAxis(i.y, pivotY, i.effScaleY),
  };
}
