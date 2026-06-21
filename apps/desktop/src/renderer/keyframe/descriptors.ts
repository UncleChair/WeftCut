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
}

export const X: ParamDescriptor = { paramKey: "x", labelKey: "property_panel.x", fallback: 0, step: 1, widgets: ["number"] };
export const Y: ParamDescriptor = { paramKey: "y", labelKey: "property_panel.y", fallback: 0, step: 1, widgets: ["number"] };
export const SCALE_X: ParamDescriptor = { paramKey: "scale_x", labelKey: "property_panel.scale_x", fallback: 1, step: 0.05, widgets: ["number"] };
export const SCALE_Y: ParamDescriptor = { paramKey: "scale_y", labelKey: "property_panel.scale_y", fallback: 1, step: 0.05, widgets: ["number"] };
export const OPACITY: ParamDescriptor = { paramKey: "opacity", labelKey: "property_panel.opacity", fallback: 1, step: 0.01, min: 0, max: 1, widgets: ["slider", "readout"] };
export const GAIN_DB: ParamDescriptor = { paramKey: "gain_db", labelKey: "property_panel.gain_db", fallback: 0, step: 0.5, min: -30, max: 20, widgets: ["number"] };
export const PAN: ParamDescriptor = { paramKey: "pan", labelKey: "property_panel.pan", fallback: 0, step: 0.05, min: -1, max: 1, widgets: ["slider"] };

export function animatableParams(kind: string): ParamDescriptor[] {
  switch (kind) {
    case "VideoClip":
    case "Motif":
      return [X, Y, SCALE_X, SCALE_Y, OPACITY];
    case "ImageOverlay":
    case "Text":
      return [X, Y, OPACITY];
    case "Audio":
      return [GAIN_DB, PAN];
    default:
      return []; // Color (Rgba only)
  }
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
