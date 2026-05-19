// Port of `engine.ts`'s `resolveAnimated` for the PixiJS-side renderer.
// Wire-compatible with the Rust `Animated<T>` enum (serde tag "mode",
// content "value"). Times are in microseconds throughout to match the
// Rust side; callers convert at the seconds boundary.
//
// Plan: docs/pixi-renderer-plan.md (P2)

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

/// Resolve a track at a given composition time. Returns `defaultValue`
/// when the track is missing or has no keyframes.
///
/// Interpolation modes: Hold (left-stick), Linear, EaseIn (u²),
/// EaseOut (1 − (1−u)²), Bezier (treated as Linear in v1 — solver
/// follows when authoring demand makes it worth the math).
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
  if (tCompUs <= kfs[0]!.t_us) return kfs[0]!.value;
  const last = kfs[kfs.length - 1]!;
  if (tCompUs >= last.t_us) return last.value;
  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1]!.t_us <= tCompUs) i++;
  const a = kfs[i]!;
  const b = kfs[i + 1]!;
  const span = b.t_us - a.t_us;
  if (span <= 0) return b.value;
  let u = (tCompUs - a.t_us) / span;
  const kind = a.interp?.kind;
  if (kind === "Hold") return a.value;
  if (kind === "EaseIn") u = u * u;
  else if (kind === "EaseOut") {
    const iu = 1 - u;
    u = 1 - iu * iu;
  }
  // Bezier: linear stub. See note above.
  return (a.value + (b.value - a.value) * u) as T;
}
