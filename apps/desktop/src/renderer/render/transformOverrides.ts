// Transient, NON-recorded transform deltas for an in-flight on-canvas drag.
// Same idiom as `effects/effectOverrides.ts`: the Compositor consults this
// AFTER resolveView (which rewrites x/y from the tracks every composite, so
// writing sprite positions directly would be clobbered on the next frame).
// Never enters React state or undo — the gesture commits once on release.
//
// Why a DELTA and not an absolute position: a keyframed layer must keep
// animating while it is being dragged, so the offset has to compose with
// whatever the tracks resolve to at the current playhead.
//
// Realm note: the export Worker builds its own Compositor in its own realm, so
// this map is always empty there — `withTransformOverride` is the identity for
// export by construction, no mode check needed.
// Spec: .scratch/preview-gizmo/spec.md (D5)

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
  /// Added to the resolved scale pair. Additive rather than absolute like every
  /// other channel here, and for the same reason: a keyframed layer must keep
  /// animating under the cursor, so the gesture composes with whatever the
  /// tracks resolve to right now. A resize handle pairs these with a
  /// compensating `dx`/`dy` too — the pivot's composed position carries a
  /// `|scale|` term (`anchorPivot.ts`), so scaling about the anchor moves `x`/`y`.
  dscaleX?: number;
  dscaleY?: number;
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
/// re-composite. Every optional channel is compared through `?? 0` — a channel
/// left out of this check would make its own drag emit exactly once and then go
/// silent for the rest of the gesture.
function sameDelta(a: TransformDelta, b: TransformDelta): boolean {
  return (
    a.dx === b.dx &&
    a.dy === b.dy &&
    (a.drotDeg ?? 0) === (b.drotDeg ?? 0) &&
    (a.danchorX ?? 0) === (b.danchorX ?? 0) &&
    (a.danchorY ?? 0) === (b.danchorY ?? 0) &&
    (a.dscaleX ?? 0) === (b.dscaleX ?? 0) &&
    (a.dscaleY ?? 0) === (b.dscaleY ?? 0)
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
