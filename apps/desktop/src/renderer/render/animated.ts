// PixiJS-side animation resolver. Wire-compatible with the Rust `Animated<T>`
// enum (serde tag "mode", content "value"). Times are in microseconds
// throughout to match the Rust side; callers convert at the seconds boundary.
//
// Plan: docs/render.md
import { loadTrack, evalTrack, type Kf } from "../eval";

export type Interpolation =
  | { kind: "Hold" }
  | { kind: "Linear" }
  | { kind: "EaseIn" }
  | { kind: "EaseOut" }
  | { kind: "Bezier"; p1: [number, number]; p2: [number, number] };

export interface Keyframe<T> {
  id: string;
  t_us: number;
  value: T;
  interp: Interpolation;
}

export type AnimTrack<T> =
  | { mode: "Static"; value: T }
  | { mode: "Keyframed"; value: Keyframe<T>[] };

/// Evaluate `cubic-bezier(x1,y1,x2,y2)` at normalized progress `x` ∈ [0,1].
///
/// INTENTIONAL JS copy — the ONLY remaining hand-mirror. The keyframe-eval path
/// (`resolveAnimated`) now runs the wasm `weftcut-eval::unit_bezier`; this copy
/// stays for the curve-graph editor overlay (`keyframe/curveGraph.ts`), a
/// UI-only use with no Rust hot-path twin. It still mirrors the leaf
/// (`native/eval/src/lib.rs::unit_bezier`); keep them in sync if either changes.
export function unitBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
): number {
  const EPS = 1e-7;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const xt = sampleX(t) - x;
    if (Math.abs(xt) < EPS) return sampleY(t);
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= xt / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  if (t < lo) return sampleY(lo);
  if (t > hi) return sampleY(hi);
  while (lo < hi) {
    const xt = sampleX(t);
    if (Math.abs(xt - x) < EPS) return sampleY(t);
    if (x > xt) lo = t;
    else hi = t;
    t = (hi - lo) * 0.5 + lo;
  }
  return sampleY(t);
}

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
/// export, and the Rust side interpolate identically (Hold / Linear /
/// EaseIn/EaseOut/Bezier). Static / empty / single-key tracks short-circuit in
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
