/// Phase B.1 — `Keyframes<T>` primitive.
///
/// Generic over the value type so the same interpolation machinery
/// drives `Keyframes<number>` (opacity, transform, scale, blur),
/// `Keyframes<Rgba>` (text color, color-fill), and any future value
/// type the IR exposes. Linear interpolation only for now — easing
/// functions can be added when the MCP exposes them.
///
/// Shape mirrors the Rust `Animated<T>` enum (`state/animated.rs`)
/// loosely:
///   - `static`: a single value, time-invariant.
///   - `keyed`: a list of `(t_us, value)` keyframes, interpolated
///     between adjacent pairs; clamped at the first / last value
///     outside the keyed range.
///
/// **No IPC consumer yet.** The current ipc views flatten
/// `Animated<T>` to T (the static value or the value at t=0). This
/// file is the forward-compat primitive shared with Phase 4's
/// keyframe MCP work — fade-window resolution (`fade.ts`) is the
/// only present-tense user.

/// A single keyframe: value at a specific time in microseconds.
export interface Keyframe<T> {
  /// Time in microseconds, project-timeline-absolute.
  tUs: number;
  value: T;
}

/// Static-or-keyed value. Cheaper than always emitting a 1-element
/// keyed list because most layer params will stay static.
export type Keyframes<T> =
  | { kind: "static"; value: T }
  | { kind: "keyed"; points: readonly Keyframe<T>[] };

/// Build a static keyframe set.
export function staticKf<T>(value: T): Keyframes<T> {
  return { kind: "static", value };
}

/// Build a keyed keyframe set. Caller is responsible for sorting
/// `points` by `tUs` ascending; we don't sort here because most
/// callers will produce them in order.
export function keyedKf<T>(points: readonly Keyframe<T>[]): Keyframes<T> {
  return { kind: "keyed", points };
}

/// Interpolator signature. `f` is the fractional position in [0, 1].
export type Interpolator<T> = (a: T, b: T, f: number) => T;

/// Linear interpolation for numbers.
export const lerpNumber: Interpolator<number> = (a, b, f) =>
  a + (b - a) * f;

/// Linear interpolation for RGBA colors (component-wise in 0–255
/// space). Matches the unit convention of the `Rgba` type from
/// `ipc/index.ts`.
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
export const lerpRgba: Interpolator<Rgba> = (a, b, f) => ({
  r: a.r + (b.r - a.r) * f,
  g: a.g + (b.g - a.g) * f,
  b: a.b + (b.b - a.b) * f,
  a: a.a + (b.a - a.a) * f,
});

/// Resolve the value at `tUs`. Clamps to first/last keyframe outside
/// the range; for an empty keyed list, returns `fallback`.
///
/// Binary search would be a micro-optimization here — typical
/// keyframe sets are 2–6 points, so linear scan is fine and
/// branch-predictor-friendly.
export function resolveAt<T>(
  kfs: Keyframes<T>,
  tUs: number,
  interp: Interpolator<T>,
  fallback: T,
): T {
  if (kfs.kind === "static") return kfs.value;
  const points = kfs.points;
  if (points.length === 0) return fallback;
  if (points.length === 1) return points[0].value;
  // Before first keyframe → clamp to first.
  if (tUs <= points[0].tUs) return points[0].value;
  // After last keyframe → clamp to last.
  const last = points[points.length - 1];
  if (tUs >= last.tUs) return last.value;
  // Inside the range — find the bracket. Linear scan; sets are small.
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (tUs >= a.tUs && tUs <= b.tUs) {
      const span = b.tUs - a.tUs;
      if (span <= 0) return b.value; // degenerate duplicate-time pair
      const f = (tUs - a.tUs) / span;
      return interp(a.value, b.value, f);
    }
  }
  // Unreachable if points are sorted; defensive fallback.
  return last.value;
}
