import type { Animated, Keyframe, LayerParams, Rgba } from '../model'

/** Mirror native/src/state/layer.rs:for_each_animated_f64 — every Animated<f64>
 *  track stored on the params (opacity + the 7 transform tracks for visual kinds;
 *  gain_db + pan for Audio). Operates on params ONLY (effects are not traversed by
 *  the Rust split/trim path). */
export function forEachAnimatedF64(p: LayerParams, fn: (a: Animated<number>) => void): void {
  switch (p.kind) {
    case 'Color': break
    case 'Text': forEachTransformF64(p.transform, fn); fn(p.opacity); break
    case 'VideoClip': forEachTransformF64(p.transform, fn); fn(p.opacity); break
    case 'ImageOverlay': forEachTransformF64(p.transform, fn); fn(p.opacity); break
    case 'Motif': forEachTransformF64(p.transform, fn); fn(p.opacity); break
    case 'Audio': fn(p.gain_db); fn(p.pan); break
  }
}
/** The anchor pair is in this walk, not just in the param-key resolvers: trim and
 *  split rebase keyframe TIMES through here, so leaving it out would strand an
 *  animated pivot at the pre-trim times while every other track moved. */
function forEachTransformF64(t: { x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; rotation_deg: Animated<number>; anchor_x: Animated<number>; anchor_y: Animated<number> }, fn: (a: Animated<number>) => void): void {
  fn(t.x); fn(t.y); fn(t.scale_x); fn(t.scale_y); fn(t.rotation_deg); fn(t.anchor_x); fn(t.anchor_y)
}

/** Mirror native/src/state/layer.rs:for_each_animated_rgba — the color track on
 *  Color and Text. (Animated<Rgba> is stored but never interpolated in v1.) */
export function forEachAnimatedRgba(p: LayerParams, fn: (a: Animated<Rgba>) => void): void {
  switch (p.kind) {
    case 'Color': fn(p.color); break
    case 'Text': fn(p.color); break
    case 'VideoClip': case 'ImageOverlay': case 'Motif': case 'Audio': break
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

/** native/src/state/animated.rs:118 — canonicalize a Keyframed track: snap each
 *  t_us, stable-sort by t_us, dedupe same-snapped-time KEEPING THE LAST (JS
 *  Array.sort is stable on Node 22; the write path appends the edited key last →
 *  last-write-wins on a collision). Returns false for an EMPTY Keyframed track
 *  (→ EmptyKeyframeTrack); Static is unchanged and always true. */
export function normalizeKeyframes<T>(a: Animated<T>, snap: (t: number) => number): boolean {
  if (a.mode !== 'Keyframed') return true
  const kfs = a.value as Keyframe<T>[]
  if (kfs.length === 0) return false
  const snapped = kfs.map((k) => ({ ...k, t_us: snap(k.t_us) }))
  snapped.sort((x, y) => x.t_us - y.t_us)
  const out: Keyframe<T>[] = []
  for (const k of snapped) {
    const last = out[out.length - 1]
    if (last && last.t_us === k.t_us) out[out.length - 1] = k
    else out.push(k)
  }
  a.value = out
  return true
}
