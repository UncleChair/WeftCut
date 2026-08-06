// Pure AnimTrack<number> transforms for the authoring UI. Each returns a NEW
// track to hand to `updateLayerParamTrack`; the actor re-normalizes
// (sort/snap/dedupe), so these need only stay self-consistent. Times are
// layer-local microseconds (the keyframe `t_us` base).
import type { AnimTrack, Interpolation, Keyframe } from "../ipc";
import { resolveAnimated } from "../render/animated";
import { interpToCoeffs } from "./curve";

function newId(): string {
  return crypto.randomUUID();
}

const DEFAULT_INTERP: Interpolation = { kind: "Linear" };

export function liftToKeyframed(
  value: number,
  tUs: number,
  interp: Interpolation = DEFAULT_INTERP,
  mkId: () => string = newId,
): AnimTrack<number> {
  return { mode: "Keyframed", value: [{ id: mkId(), t_us: tUs, value, interp }] };
}

export function collapseToStatic(
  track: AnimTrack<number>,
  tUs: number,
  fallback: number,
): AnimTrack<number> {
  const value = track.mode === "Static" ? track.value : resolveAnimated(track, tUs, fallback);
  return { mode: "Static", value };
}

/// Insert-or-update a key at `tUs`. A Static track is lifted (the new key is
/// the only key). An existing key at exactly `tUs` is updated in place (value
/// always; interp only when `interp` is given); else a new key is inserted
/// (interp = given, else copied from the preceding key, else Linear). `mkId`
/// is injected so the main-process MCP path can mint deterministic keyframe
/// ids from the actor's seeded id generator (matching Rust `new_id()` order);
/// the renderer keeps the `crypto.randomUUID` default.
export function upsertKeyframe(
  track: AnimTrack<number>,
  tUs: number,
  value: number,
  interp?: Interpolation,
  mkId: () => string = newId,
): AnimTrack<number> {
  if (track.mode === "Static") return liftToKeyframed(value, tUs, interp ?? DEFAULT_INTERP, mkId);
  const keys = track.value.slice();
  const at = keys.findIndex((k) => k.t_us === tUs);
  if (at >= 0) {
    keys[at] = { ...keys[at]!, value, ...(interp !== undefined ? { interp } : {}) };
    return { mode: "Keyframed", value: keys };
  }
  const prev = keys.filter((k) => k.t_us < tUs).pop();
  const resolved = interp ?? prev?.interp ?? DEFAULT_INTERP;
  keys.push({ id: mkId(), t_us: tUs, value, interp: resolved });
  keys.sort((a, b) => a.t_us - b.t_us);
  return { mode: "Keyframed", value: keys };
}

/// Remove a key by id. When it was the last key, collapse to a Static holding
/// that key's value (so the property keeps its on-screen value).
export function removeKeyframe(
  track: AnimTrack<number>,
  id: string,
  fallback: number,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const remaining = track.value.filter((k) => k.id !== id);
  if (remaining.length === 0) {
    const removed = track.value.find((k) => k.id === id);
    return { mode: "Static", value: removed?.value ?? fallback };
  }
  return { mode: "Keyframed", value: remaining };
}

export function retimeKeyframe(
  track: AnimTrack<number>,
  id: string,
  newTUs: number,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const keys = track.value.map((k) => (k.id === id ? { ...k, t_us: newTUs } : k));
  keys.sort((a, b) => a.t_us - b.t_us);
  return { mode: "Keyframed", value: keys };
}

export function setKeyframeInterp(
  track: AnimTrack<number>,
  id: string,
  interp: Interpolation,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  return { mode: "Keyframed", value: track.value.map((k) => (k.id === id ? { ...k, interp } : k)) };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/// Monotone-clamped tangent (value per microsecond) at interior key `i`.
/// 0 at a local extremum (or when a neighbour delta is 0).
function tangentAt(keys: Keyframe<number>[], i: number): number {
  const prev = keys[i - 1];
  const next = keys[i + 1];
  if (!prev || !next) return 0; // endpoints → flat
  const dPrev = keys[i]!.value - prev.value;
  const dNext = next.value - keys[i]!.value;
  if (dPrev === 0 || dNext === 0 || Math.sign(dPrev) !== Math.sign(dNext)) return 0;
  const dt = next.t_us - prev.t_us;
  if (dt <= 0) return 0;
  return (next.value - prev.value) / dt;
}

/// Bake monotone (no-overshoot) tangents at key `id` into the outgoing segment
/// (this key's interp.p1) and the incoming segment (previous key's interp.p2),
/// giving C1-continuous velocity through the key. The control point on the
/// untouched side is read back through `interpToCoeffs`, so a Linear/Hold
/// neighbour comes through as the identity diagonal. Returns a NEW track.
export function smoothKeyframe(track: AnimTrack<number>, id: string): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const keys = track.value;
  const i = keys.findIndex((k) => k.id === id);
  if (i < 0) return track;
  const m = tangentAt(keys, i);
  const out = keys.slice();

  // Outgoing segment i → i+1: set this key's p1 from m.
  if (i < keys.length - 1) {
    const dt = keys[i + 1]!.t_us - keys[i]!.t_us;
    const dv = keys[i + 1]!.value - keys[i]!.value;
    if (dv === 0 || dt <= 0) {
      out[i] = { ...keys[i]!, interp: { kind: "Linear" } };
    } else {
      const [, , x2, y2] = interpToCoeffs(keys[i]!.interp);
      const y1 = clamp01((m * dt) / (3 * dv));
      out[i] = { ...keys[i]!, interp: { kind: "Bezier", p1: [1 / 3, y1], p2: [x2, y2] } };
    }
  }

  // Incoming segment i-1 → i: set previous key's p2 from m.
  if (i > 0) {
    const dt = keys[i]!.t_us - keys[i - 1]!.t_us;
    const dv = keys[i]!.value - keys[i - 1]!.value;
    if (dv === 0 || dt <= 0) {
      out[i - 1] = { ...keys[i - 1]!, interp: { kind: "Linear" } };
    } else {
      const [x1, y1] = interpToCoeffs(out[i - 1]!.interp);
      const y2 = clamp01(1 - (m * dt) / (3 * dv));
      out[i - 1] = { ...out[i - 1]!, interp: { kind: "Bezier", p1: [x1, y1], p2: [2 / 3, y2] } };
    }
  }

  return { mode: "Keyframed", value: out };
}

/// Smooth every interior keyframe (one whole-track result → one undo step).
export function smoothTrack(track: AnimTrack<number>): AnimTrack<number> {
  if (track.mode === "Static") return track;
  let acc: AnimTrack<number> = track;
  for (const k of track.value) acc = smoothKeyframe(acc, k.id);
  return acc;
}

export type { Keyframe };
