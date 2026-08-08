// PixiJS-side animation resolver. Wire-compatible with the Rust `Animated<T>`
// enum (serde tag "mode", content "value"). Times are in microseconds
// throughout to match the Rust side; callers convert at the seconds boundary.
//
// Plan: docs/render.md
import {
  loadTrack,
  evalTrack,
  loadColorTrack,
  evalRgbaPacked,
  type Kf,
  type KfColor,
} from "../eval";
import type { Rgba } from "../ipc";
import type { Interpolation } from "../../shared/easing";

export type { EaseDir, Interpolation } from "../../shared/easing";

export interface Keyframe<T> {
  id: string;
  t_us: number;
  value: T;
  interp: Interpolation;
}

export type AnimTrack<T> =
  | { mode: "Static"; value: T }
  | { mode: "Keyframed"; value: Keyframe<T>[] };

// Per-track identity for the resident wasm cache. IPC re-materializes a track's
// keyframe array whenever its data changes, so the array REFERENCE changes
// exactly when the keyframes do — keying a WeakMap by it gives correct cache
// invalidation for free (loadTrack re-uploads only when the handle differs from
// the last-loaded). If the renderer ever mutated a keyframe array in place
// instead of replacing it, this would go stale — bump to a (ref, length) key.
const handles = new WeakMap<object, number>();
let nextHandle = 1;
function handleFor(kfs: object): number {
  let h = handles.get(kfs);
  if (h === undefined) {
    h = nextHandle++;
    handles.set(kfs, h);
  }
  return h;
}

/// Resolve a track at a given composition time. Returns `defaultValue`
/// when the track is missing or has no keyframes.
///
/// Genuinely-keyframed tracks (≥2 keys) delegate to the wasm
/// `weftcut-eval::eval_f64` — the SAME crate the actor + export run — so preview,
/// export, and the Rust side interpolate identically (Hold / Linear / Bezier /
/// Elastic / Bounce). Static / empty / single-key tracks short-circuit in
/// JS to avoid a wasm call for the common case. `initEval()` must have resolved
/// (the renderer bootstrap awaits it before mount).
export function resolveAnimated<T extends number>(
  track: AnimTrack<T> | null | undefined,
  tCompUs: number,
  defaultValue: T,
): T {
  if (!track) return defaultValue;
  if (track.mode === "Static") return track.value;
  const kfs = track.value;
  if (!kfs || kfs.length === 0) return defaultValue;
  if (kfs.length === 1) return kfs[0]!.value;
  loadTrack(handleFor(kfs), kfs as unknown as Kf[]);
  return evalTrack(tCompUs, 0) as T;
}

/// Color twin of `resolveAnimated`. Genuinely-keyframed color tracks (≥2 keys)
/// delegate to the wasm `weftcut-eval::eval::<Rgba8>` (OkLab + premultiplied
/// alpha) — the SAME leaf math native export runs — so preview and export
/// interpolate color identically. Reuses the shared `handleFor` WeakMap: handles
/// are globally unique, so color/scalar never collide even though their resident
/// buffers differ. Static / empty / single-key tracks short-circuit in JS.
export function resolveAnimatedColor(
  track: AnimTrack<Rgba> | null | undefined,
  tCompUs: number,
  defaultValue: Rgba,
): Rgba {
  if (!track) return defaultValue;
  if (track.mode === "Static") return track.value;
  const kfs = track.value;
  if (!kfs || kfs.length === 0) return defaultValue;
  if (kfs.length === 1) return kfs[0]!.value;
  loadColorTrack(handleFor(kfs), kfs as unknown as KfColor[]);
  return evalRgbaPacked(tCompUs, defaultValue) as Rgba;
}
