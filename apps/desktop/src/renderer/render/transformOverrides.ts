// Transient, NON-recorded position deltas for an in-flight on-canvas drag.
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
}

const deltas = new Map<string, TransformDelta>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setTransformOverride(layerId: string, delta: TransformDelta): void {
  const prev = deltas.get(layerId);
  if (prev && prev.dx === delta.dx && prev.dy === delta.dy) return;
  deltas.set(layerId, delta);
  emit();
}

export function clearTransformOverride(layerId: string): void {
  if (deltas.delete(layerId)) emit();
}

export function transformOverrideFor(layerId: string): TransformDelta | undefined {
  return deltas.get(layerId);
}

/// Fold the live drag delta into a resolved view. Returns the input untouched
/// when nothing is being dragged, so the common path allocates nothing.
export function withTransformOverride<T extends { x: number; y: number }>(
  layerId: string,
  view: T,
): T {
  const d = deltas.get(layerId);
  if (!d) return view;
  return { ...view, x: view.x + d.dx, y: view.y + d.dy };
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
