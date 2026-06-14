// The frontend mirror of the Rust `resolve_animated_f64_mut`: which params
// each layer kind can keyframe, in inspector order. The IPC view flattens
// transform, so `params[paramKey]` is the `AnimTrack<number>`.
import type { AnimTrack, LayerSummary } from "../ipc";

export interface ParamDescriptor {
  /// Wire key understood by `updateLayerParamTrack` and the Rust resolver.
  paramKey: string;
  /// Existing i18n key (reuse the property-panel labels).
  labelKey: string;
  /// Static fallback used when a Keyframed track is empty / before its first key.
  fallback: number;
}

const X: ParamDescriptor = { paramKey: "x", labelKey: "property_panel.x", fallback: 0 };
const Y: ParamDescriptor = { paramKey: "y", labelKey: "property_panel.y", fallback: 0 };
const SCALE_X: ParamDescriptor = { paramKey: "scale_x", labelKey: "property_panel.scale_x", fallback: 1 };
const SCALE_Y: ParamDescriptor = { paramKey: "scale_y", labelKey: "property_panel.scale_y", fallback: 1 };
const OPACITY: ParamDescriptor = { paramKey: "opacity", labelKey: "property_panel.opacity", fallback: 1 };
const GAIN_DB: ParamDescriptor = { paramKey: "gain_db", labelKey: "property_panel.gain_db", fallback: 0 };
const PAN: ParamDescriptor = { paramKey: "pan", labelKey: "property_panel.pan", fallback: 0 };

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
      return []; // Color (Rgba only), Subtitles
  }
}

/// Read the `AnimTrack<number>` for `paramKey` off the flattened params view.
/// `null` if the kind doesn't carry that param.
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
