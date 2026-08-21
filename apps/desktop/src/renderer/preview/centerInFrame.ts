// Centring a layer in the frame, as pure geometry: a layer's transform frame at
// an instant, and the `x`/`y` shift that puts its visible box in the middle of
// the composition. No renderer, no store, no IPC — the commands in
// `commands/appCommands.ts` supply the layer, the probe's natural size and the
// commit.
//
// LANDMINE: `transformOriginFor` and `layerFrameAt` are twins of
// `TransformGizmo.tsx`'s private `originFor` / `frameAt`, and nothing enforces
// the agreement. If they drift, the gizmo draws a box around one rectangle while
// "Center horizontally" centres another. Change one, change both — or better,
// collapse the gizmo onto this module.

import type { AnimTrack, LayerSummary } from "../ipc";
import { resolveAnimated } from "../render/animated";
import { DEFAULT_ANCHOR } from "../render/anchorPivot";
import { layerQuad, type LayerQuadInput, type Pt, type TransformOrigin } from "./gizmoGeometry";
import { quadAabb } from "./previewSnap";

/// The kinds that carry a transform at all. `Color` fills the composition, so it
/// is already centred by construction, and `Audio` has no footprint.
export const TRANSFORMABLE_KINDS: ReadonlySet<string> = new Set([
  "VideoClip",
  "ImageOverlay",
  "Text",
  "Motif",
]);

/// docs/data-model.md#transform: only Text stores the anchor point as `x`/`y`.
/// ADR 0049 keeps that asymmetry deliberately, which is why every consumer of a
/// layer's geometry has to ask rather than assume.
export function transformOriginFor(kind: string): TransformOrigin {
  return kind === "Text" ? "anchor" : "top-left";
}

/// The flattened transform fields, read through one cast at the edge because
/// `LayerParamsView` is a discriminated union and this is deliberately
/// kind-agnostic past the `TRANSFORMABLE_KINDS` gate.
interface TransformFields {
  kind: string;
  x?: AnimTrack<number>;
  y?: AnimTrack<number>;
  scale_x?: AnimTrack<number>;
  scale_y?: AnimTrack<number>;
  rotation_deg?: AnimTrack<number>;
  anchor_x?: AnimTrack<number>;
  anchor_y?: AnimTrack<number>;
}

/// A layer's transform frame at an ABSOLUTE time, given the untransformed
/// content size the compositor reports for it (`GizmoProbe.naturalSizeOf`).
///
/// `DEFAULT_ANCHOR` and nothing else for the anchor fallback — the same constant
/// the renderer resolves through, so this frame and the picture cannot pivot
/// about different points.
export function layerFrameAt(
  layer: LayerSummary,
  tUs: number,
  size: { w: number; h: number },
): LayerQuadInput {
  const p = layer.params as unknown as TransformFields;
  const tLocalUs = tUs - layer.t_start_us;
  return {
    x: resolveAnimated(p.x, tLocalUs, 0),
    y: resolveAnimated(p.y, tLocalUs, 0),
    anchorX: resolveAnimated(p.anchor_x, tLocalUs, DEFAULT_ANCHOR),
    anchorY: resolveAnimated(p.anchor_y, tLocalUs, DEFAULT_ANCHOR),
    naturalW: size.w,
    naturalH: size.h,
    scaleX: resolveAnimated(p.scale_x, tLocalUs, 1),
    scaleY: resolveAnimated(p.scale_y, tLocalUs, 1),
    rotationDeg: resolveAnimated(p.rotation_deg, tLocalUs, 0),
    origin: transformOriginFor(p.kind),
  };
}

/// The `x`/`y` delta that moves the layer's AXIS-ALIGNED BOUNDING BOX onto the
/// composition's centre. Null on a degenerate quad.
///
/// Going through the AABB is what makes one formula correct for both origin
/// conventions AND for a rotated or flipped layer: whatever `x`/`y` names, the
/// mapped quad is where the content actually lands, and shifting `x` by
/// `centre − boxCentre` translates that landing rigidly. Per-origin arithmetic
/// would have to special-case Text against the media kinds and would still put a
/// rotated layer's corner, not its extent, in the middle.
///
/// The caller picks the axis: writing both would move a layer the user asked to
/// centre on one.
export function centerShift(frame: LayerQuadInput, compW: number, compH: number): Pt | null {
  const box = quadAabb(layerQuad(frame));
  if (!box) return null;
  return {
    x: compW / 2 - (box.left + box.right) / 2,
    y: compH / 2 - (box.top + box.bottom) / 2,
  };
}
