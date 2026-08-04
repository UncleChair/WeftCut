// The frontend mirror of the Rust `resolve_animated_f64_mut`: which params
// each layer kind can keyframe, in inspector order. The IPC view flattens
// transform, so `params[paramKey]` is the `AnimTrack<number>`.
import type { AnimTrack, LayerSummary } from "../ipc";

export type KfWidget = "slider" | "number" | "readout";

export interface ParamDescriptor {
  /// Wire key understood by `updateLayerParamTrack` and the Rust resolver.
  paramKey: string;
  /// Existing i18n key (reuse the property-panel labels).
  labelKey: string;
  /// Static fallback used when a Keyframed track is empty / before its first key.
  fallback: number;
  /// Number-field / slider step (absent ⇒ default 1).
  step?: number;
  /// Optional domain bounds.
  min?: number;
  max?: number;
  /// Default inspector presentation, rendered in order, all bound to one value.
  /// Consumers (e.g. the timeline) may override per call.
  widgets?: KfWidget[];
  /// Composite marker: commits fan the authored track out to every listed key
  /// (structural twin copies, fresh ids) through the plural batch mutation, so
  /// the whole write is one undo. Reads still come from `paramKey`.
  fanOutKeys?: string[];
}

export const X: ParamDescriptor = { paramKey: "x", labelKey: "property_panel.x", fallback: 0, step: 1, widgets: ["number"] };
export const Y: ParamDescriptor = { paramKey: "y", labelKey: "property_panel.y", fallback: 0, step: 1, widgets: ["number"] };
export const SCALE_X: ParamDescriptor = { paramKey: "scale_x", labelKey: "property_panel.scale_x", fallback: 1, step: 0.05, widgets: ["number"] };
export const SCALE_Y: ParamDescriptor = { paramKey: "scale_y", labelKey: "property_panel.scale_y", fallback: 1, step: 0.05, widgets: ["number"] };
/// The two keys the composite Scale writes — the single home for the pair
/// (SCALE.fanOutKeys and the timeline's link-aware sink both read it here).
const SCALE_PAIR = ["scale_x", "scale_y"];
/// The collapsed "Scale" a linked layer shows instead of SCALE_X + SCALE_Y.
/// Reads scale_x (linked ⇒ the tracks are twins, either side is truthful);
/// writes fan out to both axes as one batch.
export const SCALE: ParamDescriptor = { paramKey: "scale_x", labelKey: "property_panel.scale", fallback: 1, step: 0.05, widgets: ["number"], fanOutKeys: SCALE_PAIR };
export const ROTATION: ParamDescriptor = { paramKey: "rotation_deg", labelKey: "property_panel.rotation", fallback: 0, step: 1, widgets: ["number"] };
export const OPACITY: ParamDescriptor = { paramKey: "opacity", labelKey: "property_panel.opacity", fallback: 1, step: 0.01, min: 0, max: 1, widgets: ["slider", "readout"] };
export const GAIN_DB: ParamDescriptor = { paramKey: "gain_db", labelKey: "property_panel.gain_db", fallback: 0, step: 0.5, min: -30, max: 20, widgets: ["number"] };
export const PAN: ParamDescriptor = { paramKey: "pan", labelKey: "property_panel.pan", fallback: 0, step: 0.05, min: -1, max: 1, widgets: ["slider"] };

/// `scaleLinked` collapses the scale pair into the composite SCALE descriptor —
/// pass the layer's `scale_linked` so every consumer (inspector rows, timeline
/// lanes, curve graph, search) shows ONE Scale for a linked layer.
export function animatableParams(kind: string, scaleLinked = false): ParamDescriptor[] {
  switch (kind) {
    case "VideoClip":
    case "Motif":
    case "ImageOverlay":
    case "Text":
      return scaleLinked ? [X, Y, SCALE, ROTATION, OPACITY] : [X, Y, SCALE_X, SCALE_Y, ROTATION, OPACITY];
    case "Audio":
      return [GAIN_DB, PAN];
    default:
      return []; // Color (Rgba only)
  }
}

/// The layer's `scale_linked` off the flattened params view (false for kinds
/// without a transform, and for a null/missing layer) — the argument
/// `animatableParams` wants.
export function readScaleLinked(params: LayerSummary["params"] | null | undefined): boolean {
  return (params as unknown as { scale_linked?: boolean } | null | undefined)?.scale_linked === true;
}

/// The keys a write to `paramKey` on this layer must fan out to, or null for a
/// plain single-track write — the timeline sink's one question. Non-null
/// exactly when the layer is linked and the key is either scale axis.
export function scaleFanOutFor(paramKey: string, params: LayerSummary["params"] | null | undefined): string[] | null {
  return SCALE_PAIR.includes(paramKey) && readScaleLinked(params) ? SCALE_PAIR : null;
}

/// True when `paramKey` on this layer is the composite Scale's hidden twin:
/// a linked layer's scale is ONE lane (reading scale_x), so its keyed scale_y
/// must not surface diamonds or navigator stops in a neighbour's Scale Y lane.
export function isHiddenTwinAxis(paramKey: string, params: LayerSummary["params"] | null | undefined): boolean {
  return paramKey === "scale_y" && readScaleLinked(params);
}

/// Read the `AnimTrack<number>` for `paramKey` off the flattened params view.
/// `null` if the kind doesn't carry that param. Call ONLY with keys from
/// `animatableParams(kind)`: passing a non-f64 track key (e.g. `"color"`, which
/// is `AnimTrack<Rgba>`) would return it mis-typed as `AnimTrack<number>`.
export function readParamTrack(
  params: LayerSummary["params"],
  paramKey: string,
): AnimTrack<number> | null {
  const v = (params as unknown as Record<string, unknown>)[paramKey];
  if (v && typeof v === "object" && "mode" in (v as object)) {
    return v as AnimTrack<number>;
  }
  return null;
}
