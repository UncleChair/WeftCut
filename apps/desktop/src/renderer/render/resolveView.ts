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

// `scale_linked` is also omitted from every transform-bearing Resolved view:
// it is EDITING intent (which the inspector/timeline read off the raw view),
// not a render input — by the time tracks are resolved to scalars the twin
// pair is already two equal numbers.
export interface ResolvedVideoClipView
  extends Omit<VideoClipView, "x" | "y" | "scale_x" | "scale_y" | "rotation_deg" | "opacity" | "scale_linked"> {
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  opacity: number;
}
export interface ResolvedImageOverlayView
  extends Omit<ImageOverlayView, "x" | "y" | "scale_x" | "scale_y" | "rotation_deg" | "opacity" | "scale_linked"> {
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  opacity: number;
}
export interface ResolvedTextView
  extends Omit<TextView, "color" | "x" | "y" | "scale_x" | "scale_y" | "rotation_deg" | "opacity" | "scale_linked"> {
  color: Rgba;
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  opacity: number;
}
export interface ResolvedColorView extends Omit<ColorView, "color"> {
  color: Rgba;
}
export interface ResolvedMotifView
  extends Omit<MotifView, "x" | "y" | "scale_x" | "scale_y" | "rotation_deg" | "opacity" | "scale_linked"> {
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  opacity: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };

export function resolveVideoClipView(v: VideoClipView, tInLayerUs: number): ResolvedVideoClipView {
  return {
    ...v,
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    rotation_deg: resolveAnimated(v.rotation_deg, tInLayerUs, 0),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}

export function resolveImageOverlayView(
  v: ImageOverlayView,
  tInLayerUs: number,
): ResolvedImageOverlayView {
  return {
    ...v,
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    rotation_deg: resolveAnimated(v.rotation_deg, tInLayerUs, 0),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}

export function resolveTextView(v: TextView, tInLayerUs: number): ResolvedTextView {
  return {
    ...v,
    color: resolveAnimatedColor(v.color, tInLayerUs, WHITE),
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    rotation_deg: resolveAnimated(v.rotation_deg, tInLayerUs, 0),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}

export function resolveColorView(v: ColorView, tInLayerUs: number): ResolvedColorView {
  return { ...v, color: resolveAnimatedColor(v.color, tInLayerUs, BLACK) };
}

export function resolveMotifView(v: MotifView, tInLayerUs: number): ResolvedMotifView {
  return {
    ...v,
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    rotation_deg: resolveAnimated(v.rotation_deg, tInLayerUs, 0),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}
