import type { Animated, Keyframe, LayerParams, Rgba } from '../model'

/** Mirror native/src/state/layer.rs:for_each_animated_f64 — every Animated<f64>
 *  track stored on the params (opacity + the 5 transform tracks for visual kinds;
 *  gain_db + pan for Audio). Operates on params ONLY (effects are not traversed by
 *  the Rust split/trim path). */
export function forEachAnimatedF64(p: LayerParams, fn: (a: Animated<number>) => void): void {
  switch (p.kind) {
    case 'Color': break
    case 'Text': fn(p.opacity); forEachTransformF64(p.transform, fn); break
    case 'VideoClip': fn(p.opacity); forEachTransformF64(p.transform, fn); break
    case 'ImageOverlay': fn(p.opacity); forEachTransformF64(p.transform, fn); break
    case 'Motif': fn(p.opacity); forEachTransformF64(p.transform, fn); break
    case 'Audio': fn(p.gain_db); fn(p.pan); break
  }
}
function forEachTransformF64(t: { x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; rotation_deg: Animated<number> }, fn: (a: Animated<number>) => void): void {
  fn(t.x); fn(t.y); fn(t.scale_x); fn(t.scale_y); fn(t.rotation_deg)
}

/** Mirror native/src/state/layer.rs:for_each_animated_rgba — the color track on
 *  Color and Text. (Animated<Rgba> is stored but never interpolated in v1.) */
export function forEachAnimatedRgba(p: LayerParams, fn: (a: Animated<Rgba>) => void): void {
  switch (p.kind) {
    case 'Color': fn(p.color); break
    case 'Text': fn(p.color); break
    default: break
  }
}

export function shiftKeyframes<T>(a: Animated<T>, deltaUs: number): void {
  if (a.mode === 'Keyframed') for (const k of a.value as Keyframe<T>[]) k.t_us += deltaUs
}
export function retainKeyframes<T>(a: Animated<T>, pred: (tUs: number) => boolean): void {
  if (a.mode === 'Keyframed') a.value = (a.value as Keyframe<T>[]).filter((k) => pred(k.t_us))
}
export function firstKeyframeValue<T>(a: Animated<T>): T | null {
  if (a.mode === 'Static') return a.value
  const kfs = a.value as Keyframe<T>[]
  return kfs.length ? kfs[0].value : null
}
export function lastKeyframeValue<T>(a: Animated<T>): T | null {
  if (a.mode === 'Static') return a.value
  const kfs = a.value as Keyframe<T>[]
  return kfs.length ? kfs[kfs.length - 1].value : null
}
/** Rewrite `a` in place into Static(value) — used to collapse an emptied
 *  Keyframed half (animated.rs split semantics). */
export function collapseToStatic<T>(a: Animated<T>, value: T): void {
  const m = a as { mode: 'Static'; value: T }
  m.mode = 'Static'; m.value = value
}
