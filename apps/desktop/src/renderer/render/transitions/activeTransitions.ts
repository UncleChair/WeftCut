// Active-transition selection + window/progress math for the compositor's
// two-input transition node (TransitionNodes.ts). Pure — the caller injects
// the layer/track lookups, so this is unit-testable without a Compositor.
//
// Placement-independent (overlap or extend, ADR 0048): a transition's window
// IS the authorized overlap, `[to.t_start_us, to.t_start_us + duration_us)`.
// Progress is fixed linear
// (easing is a future additive parameter, never a keyframe track).

import type { TransitionSummary } from "../../ipc";

/// The slice of a `LayerSummary` the selector reads. `kind` is the top-level
/// layer-kind discriminant (`LayerSummary.kind`), not `params.kind`.
export interface ParticipantLayer {
  t_start_us: number;
  t_end_us: number;
  enabled: boolean;
  kind: string;
}

export interface ActiveTransition {
  id: string;
  fromLayerId: string;
  toLayerId: string;
  kind: TransitionSummary["kind"];
  /// Window start == the incoming layer's `t_start_us`.
  startUs: number;
  durationUs: number;
  /// Linear `(t − startUs) / durationUs`, clamped to [0, 1].
  progress: number;
}

/// Layer kinds a transition may composite. Audio participants are rejected
/// at the mutation seam; this is the render-side backstop so a stale
/// snapshot can never divert an Audio layer into the visual node.
export const VISUAL_LAYER_KINDS: ReadonlySet<string> = new Set([
  "VideoClip",
  "ImageOverlay",
  "Color",
  "Text",
  "Motif",
]);

export function transitionProgress(
  tUs: number,
  startUs: number,
  durationUs: number,
): number {
  if (durationUs <= 0) return 1;
  const p = (tUs - startUs) / durationUs;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/// Shared empty result — `compositeFrame` calls this every frame, so the
/// no-transitions case must not allocate.
const NONE: ActiveTransition[] = [];

/// Transitions whose window contains `tUs` AND whose participants can
/// actually render this frame (both layers present, enabled, on enabled
/// tracks, visual kinds, covering `tUs`). Reconcile owns the invariant at
/// the commit seam; every check here is a backstop so a mid-edit snapshot
/// degrades to normal drawing instead of a half-baked node. A layer joins
/// at most one node per frame — the first transition in array order claims
/// its participants.
export function selectActiveTransitions(
  transitions: readonly TransitionSummary[] | undefined,
  tUs: number,
  getLayer: (layerId: string) => ParticipantLayer | undefined,
  isTrackEnabled: (layerId: string) => boolean,
): ActiveTransition[] {
  if (!transitions || transitions.length === 0) return NONE;
  let out: ActiveTransition[] | null = null;
  let claimed: Set<string> | null = null;
  for (const tr of transitions) {
    if (tr.duration_us <= 0) continue;
    const from = getLayer(tr.from_layer);
    const to = getLayer(tr.to_layer);
    if (!from || !to) continue;
    if (!from.enabled || !to.enabled) continue;
    if (!isTrackEnabled(tr.from_layer) || !isTrackEnabled(tr.to_layer)) continue;
    if (!VISUAL_LAYER_KINDS.has(from.kind) || !VISUAL_LAYER_KINDS.has(to.kind)) continue;
    const startUs = to.t_start_us;
    if (tUs < startUs || tUs >= startUs + tr.duration_us) continue;
    if (tUs < from.t_start_us || tUs >= from.t_end_us) continue;
    if (tUs >= to.t_end_us) continue;
    if (claimed?.has(tr.from_layer) || claimed?.has(tr.to_layer)) continue;
    (claimed ??= new Set()).add(tr.from_layer);
    claimed.add(tr.to_layer);
    (out ??= []).push({
      id: tr.id,
      fromLayerId: tr.from_layer,
      toLayerId: tr.to_layer,
      kind: tr.kind,
      startUs,
      durationUs: tr.duration_us,
      progress: transitionProgress(tUs, startUs, tr.duration_us),
    });
  }
  return out ?? NONE;
}
