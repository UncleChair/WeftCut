// Transient, NON-recorded transform deltas for an in-flight on-canvas drag.
// Same idiom as `effects/effectOverrides.ts`: the Compositor consults this
// AFTER resolveView (which rewrites x/y from the tracks every composite, so
// writing sprite positions directly would be clobbered on the next frame).
// Never enters React state or undo — the gesture commits once on release.
//
// Why a DELTA and not an absolute position: a keyframed layer must keep
// animating while it is being dragged, so the offset has to compose with
// whatever the tracks resolve to at the current playhead. The Text box pair is
// the one exception, and `boxW` names why the rule does not reach it.
//
// Realm note: the export Worker builds its own Compositor in its own realm, so
// this map is always empty there — both `with…Override` functions are the
// identity for export by construction, no mode check needed.
// Spec: docs/features.md#on-canvas-transform-gizmo

export interface TransformDelta {
  dx: number;
  dy: number;
  /// Degrees added to the resolved `rotation_deg`. Additive like the position
  /// pair and for the same reason — and nothing else moves, because the engine
  /// already rotates about the anchor (`anchorPivot.ts`), so a rotation gesture
  /// needs no compensating x/y.
  drotDeg?: number;
  /// Normalized units added to the resolved anchor pair. An anchor gesture DOES
  /// move the picture (it moves the pivot), so the gizmo pairs these with a
  /// compensating `dx`/`dy` in the same delta — that is why they live in one
  /// struct rather than a second override map: the preview must apply both
  /// halves on the same frame or the layer visibly jumps mid-drag.
  danchorX?: number;
  danchorY?: number;
  /// Added to the resolved scale pair (additive, same reason as `dx`/`dy`). A
  /// resize handle pairs these with a compensating `dx`/`dy` — the pivot's
  /// composed position carries a `|scale|` term (`anchorPivot.ts`), so scaling
  /// about the anchor moves `x`/`y`.
  dscaleX?: number;
  dscaleY?: number;
  /// The Text layout box, ABSOLUTE composition pixels — the only channel here
  /// that is not a delta, and the only one where `null` is a value ("Auto on that
  /// axis"), so absent / null / number are three distinct states.
  ///
  /// It breaks this module's additive convention because the convention's reason
  /// does not reach it: every other channel adds to a track so a keyframed layer
  /// keeps animating mid-drag, and `box_w`/`box_h` are deliberately NOT
  /// `Animated` (ADR 0049 — a keyframed box would rebuild the glyph atlas every
  /// frame). With no track to add to, the only thing an override can carry is the
  /// value itself.
  boxW?: number | null;
  boxH?: number | null;
}

const deltas = new Map<string, TransformDelta>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setTransformOverride(layerId: string, delta: TransformDelta): void {
  const prev = deltas.get(layerId);
  if (prev && sameDelta(prev, delta)) return;
  deltas.set(layerId, delta);
  emit();
}

/// Field-wise equality, so a pointermove that moved nothing costs no
/// re-composite. Every optional DELTA channel is compared through `?? 0` — a
/// channel left out of this check would make its own drag emit exactly once and
/// then go silent for the rest of the gesture.
///
/// The box pair is compared RAW, because `?? 0` would fold its two distinct
/// "no box" states — absent and `null` — onto a 0 px box and make the step out of
/// Fixed invisible to this check.
function sameDelta(a: TransformDelta, b: TransformDelta): boolean {
  return (
    a.dx === b.dx &&
    a.dy === b.dy &&
    (a.drotDeg ?? 0) === (b.drotDeg ?? 0) &&
    (a.danchorX ?? 0) === (b.danchorX ?? 0) &&
    (a.danchorY ?? 0) === (b.danchorY ?? 0) &&
    (a.dscaleX ?? 0) === (b.dscaleX ?? 0) &&
    (a.dscaleY ?? 0) === (b.dscaleY ?? 0) &&
    a.boxW === b.boxW &&
    a.boxH === b.boxH
  );
}

export function clearTransformOverride(layerId: string): void {
  if (deltas.delete(layerId)) emit();
}

export function transformOverrideFor(layerId: string): TransformDelta | undefined {
  return deltas.get(layerId);
}

/// Fold the live drag delta into a resolved view. Returns the input untouched
/// when nothing is being dragged, so the common path allocates nothing.
export function withTransformOverride<
  T extends {
    x: number;
    y: number;
    scale_x: number;
    scale_y: number;
    rotation_deg: number;
    anchor_x: number;
    anchor_y: number;
  },
>(layerId: string, view: T): T {
  const d = deltas.get(layerId);
  if (!d) return view;
  return {
    ...view,
    x: view.x + d.dx,
    y: view.y + d.dy,
    scale_x: view.scale_x + (d.dscaleX ?? 0),
    scale_y: view.scale_y + (d.dscaleY ?? 0),
    rotation_deg: view.rotation_deg + (d.drotDeg ?? 0),
    anchor_x: view.anchor_x + (d.danchorX ?? 0),
    anchor_y: view.anchor_y + (d.danchorY ?? 0),
  };
}

/// The Text half of the same map, applied on top of `withTransformOverride` so
/// the box and the transform channels reach the sprite on ONE frame — the same
/// reason the anchor pair and its compensation share a single delta. A channel
/// left absent leaves the layer's own box alone, which is every other kind and
/// every gesture that is not a box resize.
///
/// COST, so nobody has to rediscover it with a profiler: a box that changes
/// invalidates `TextSprite.appliedSig`, so the shrink-to-fit binary search re-runs
/// and Pixi re-rasterizes the glyph atlas — once per pointermove that moves the
/// box. Deliberately accepted; it is what makes wrapping, shrink-to-fit and the
/// gizmo's shrink/overflow stroke visible DURING the gesture they are meant to
/// guide, and it is what Figma does. Bounded on both sides: Pixi's
/// `CanvasTextMetrics` measurement cache is capped at 1000 entries, and the
/// discarded atlases are reclaimed by `TextureGCSystem`.
export function withTextBoxOverride<T extends { box_w: number | null; box_h: number | null }>(
  layerId: string,
  view: T,
): T {
  const d = deltas.get(layerId);
  if (!d || (d.boxW === undefined && d.boxH === undefined)) return view;
  return {
    ...view,
    // Not `??` — `null` is the payload for "back to Auto", and `??` would read it
    // as "absent" and hand back the layer's old box instead.
    box_w: d.boxW !== undefined ? d.boxW : view.box_w,
    box_h: d.boxH !== undefined ? d.boxH : view.box_h,
  };
}

/// The preview subscribes to re-composite on change: while paused, the stage
/// re-renders every tick but only `compositeFrame` re-reads the views.
export function subscribeTransformOverrides(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetTransformOverrides(): void {
  if (deltas.size === 0) return;
  deltas.clear();
  emit();
}
