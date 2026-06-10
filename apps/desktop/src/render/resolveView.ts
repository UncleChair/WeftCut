// Raw IPC views carry AnimTrack<T>; sprites consume plain scalars. The
// Compositor calls these once per layer per frame with the layer-LOCAL
// time (keyframe t_us is relative to the layer's t_start_us). One
// resolution point — preview and the export Worker share it, so
// keyframed properties hold preview==export by construction.
//
// Rgba tracks resolve via trackStatic: Rust has no Animated<Rgba>::value_at
// yet, and the engine-pair rule (state/animated.rs <-> render/animated.ts)
// forbids a TS-only interpolator. Wire the Rust twin first, then upgrade.
//
// Fallback constants mirror the Rust builder's old `static_or` fallbacks
// (x/y -> 0, scale -> 1, opacity -> 1, gain/pan -> 0, text WHITE, color BLACK).
import type {
  AudioView,
  ColorView,
  ImageOverlayView,
  MotifView,
  Rgba,
  TextView,
  VideoClipView,
} from "../ipc";
import { trackStatic } from "../ipc";
import { resolveAnimated } from "./animated";

export interface ResolvedVideoClipView
  extends Omit<VideoClipView, "x" | "y" | "scale_x" | "scale_y" | "opacity"> {
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  opacity: number;
}
export interface ResolvedImageOverlayView
  extends Omit<ImageOverlayView, "x" | "y" | "scale_x" | "scale_y" | "opacity"> {
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  opacity: number;
}
export interface ResolvedTextView extends Omit<TextView, "color" | "x" | "y" | "opacity"> {
  color: Rgba;
  x: number;
  y: number;
  opacity: number;
}
export interface ResolvedColorView extends Omit<ColorView, "color"> {
  color: Rgba;
}
export interface ResolvedAudioView extends Omit<AudioView, "gain_db" | "pan"> {
  gain_db: number;
  pan: number;
}
export interface ResolvedMotifView
  extends Omit<MotifView, "x" | "y" | "scale_x" | "scale_y" | "opacity"> {
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
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
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}

export function resolveTextView(v: TextView, tInLayerUs: number): ResolvedTextView {
  return {
    ...v,
    color: trackStatic(v.color, WHITE),
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}

export function resolveColorView(v: ColorView): ResolvedColorView {
  return { ...v, color: trackStatic(v.color, BLACK) };
}

export function resolveAudioView(v: AudioView, tInLayerUs: number): ResolvedAudioView {
  return {
    ...v,
    gain_db: resolveAnimated(v.gain_db, tInLayerUs, 0),
    pan: resolveAnimated(v.pan, tInLayerUs, 0),
  };
}

export function resolveMotifView(v: MotifView, tInLayerUs: number): ResolvedMotifView {
  return {
    ...v,
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}
