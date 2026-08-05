// Raw IPC views carry AnimTrack<T>; sprites consume plain scalars. The
// Compositor calls these once per layer per frame with the layer-LOCAL
// time (keyframe t_us is relative to the layer's t_start_us). One
// resolution point — preview and the export Worker share it, so
// keyframed properties hold preview==export by construction.
//
// Fallback constants mirror the Rust view builder's per-property defaults
// when a track is absent (x/y/rotation -> 0, scale/opacity -> 1,
// gain/pan -> 0, text WHITE, color BLACK).
import type {
  ColorView,
  ImageOverlayView,
  MotifView,
  Rgba,
  TextView,
  VideoClipView,
} from "../ipc";
import { resolveAnimated, resolveAnimatedColor } from "./animated";
import { DEFAULT_ANCHOR } from "./anchorPivot";

/// The transform tracks every visual view resolves, so a new one can't be added
/// to some kinds and forgotten on others.
type TransformTrackKey =
  | "x"
  | "y"
  | "scale_x"
  | "scale_y"
  | "rotation_deg"
  | "anchor_x"
  | "anchor_y"
  | "opacity";

/// The resolved scalars, spliced over the raw view's track fields.
interface ResolvedTransform {
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  /// LANDMINE: this must fall back to `DEFAULT_ANCHOR` and nothing else. The box
  /// drawn by the on-canvas gizmo derives from the same constant; a local `?? 0`
  /// here is exactly how the box and the picture once pivoted around different
  /// points, with neither looking broken alone (anchorPivot.ts).
  anchor_x: number;
  anchor_y: number;
  opacity: number;
}

// `scale_linked` is also omitted from every transform-bearing Resolved view:
// it is EDITING intent (which the inspector/timeline read off the raw view),
// not a render input — by the time tracks are resolved to scalars the twin
// pair is already two equal numbers.
export interface ResolvedVideoClipView
  extends Omit<VideoClipView, TransformTrackKey | "scale_linked">,
    ResolvedTransform {}
export interface ResolvedImageOverlayView
  extends Omit<ImageOverlayView, TransformTrackKey | "scale_linked">,
    ResolvedTransform {}
export interface ResolvedTextView
  extends Omit<TextView, TransformTrackKey | "color" | "scale_linked">,
    ResolvedTransform {
  color: Rgba;
}
export interface ResolvedColorView extends Omit<ColorView, "color"> {
  color: Rgba;
}
export interface ResolvedMotifView
  extends Omit<MotifView, TransformTrackKey | "scale_linked">,
    ResolvedTransform {}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };

/// The transform+opacity resolution shared by all four visual kinds. One
/// function rather than a copy per kind: the four used to be identical bodies,
/// and adding the anchor pair to three of them would have been a silent
/// kind-specific pivot difference.
function resolveTransform(
  v: Pick<VideoClipView, TransformTrackKey>,
  tInLayerUs: number,
): ResolvedTransform {
  return {
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    rotation_deg: resolveAnimated(v.rotation_deg, tInLayerUs, 0),
    anchor_x: resolveAnimated(v.anchor_x, tInLayerUs, DEFAULT_ANCHOR),
    anchor_y: resolveAnimated(v.anchor_y, tInLayerUs, DEFAULT_ANCHOR),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}

export function resolveVideoClipView(v: VideoClipView, tInLayerUs: number): ResolvedVideoClipView {
  return { ...v, ...resolveTransform(v, tInLayerUs) };
}

export function resolveImageOverlayView(
  v: ImageOverlayView,
  tInLayerUs: number,
): ResolvedImageOverlayView {
  return { ...v, ...resolveTransform(v, tInLayerUs) };
}

export function resolveTextView(v: TextView, tInLayerUs: number): ResolvedTextView {
  return {
    ...v,
    ...resolveTransform(v, tInLayerUs),
    color: resolveAnimatedColor(v.color, tInLayerUs, WHITE),
  };
}

export function resolveColorView(v: ColorView, tInLayerUs: number): ResolvedColorView {
  return { ...v, color: resolveAnimatedColor(v.color, tInLayerUs, BLACK) };
}

export function resolveMotifView(v: MotifView, tInLayerUs: number): ResolvedMotifView {
  return { ...v, ...resolveTransform(v, tInLayerUs) };
}
