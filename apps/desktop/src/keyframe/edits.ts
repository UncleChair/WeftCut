// Pure AnimTrack<number> transforms for the authoring UI. Each returns a NEW
// track to hand to `updateLayerParamTrack`; the actor re-normalizes
// (sort/snap/dedupe), so these need only stay self-consistent. Times are
// layer-local microseconds (the keyframe `t_us` base).
import type { AnimTrack, Interpolation, Keyframe } from "../ipc";
import { resolveAnimated } from "../render/animated";

function newId(): string {
  return crypto.randomUUID();
}

const DEFAULT_INTERP: Interpolation = { kind: "Linear" };

export function liftToKeyframed(value: number, tUs: number): AnimTrack<number> {
  return { mode: "Keyframed", value: [{ id: newId(), t_us: tUs, value, interp: DEFAULT_INTERP }] };
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
/// the only key). An existing key at exactly `tUs` is updated in place; else a
/// new key is inserted (interp copied from the preceding key, or Linear).
export function upsertKeyframe(
  track: AnimTrack<number>,
  tUs: number,
  value: number,
): AnimTrack<number> {
  if (track.mode === "Static") return liftToKeyframed(value, tUs);
  const keys = track.value.slice();
  const at = keys.findIndex((k) => k.t_us === tUs);
  if (at >= 0) {
    keys[at] = { ...keys[at]!, value };
    return { mode: "Keyframed", value: keys };
  }
  const prev = keys.filter((k) => k.t_us < tUs).pop();
  const interp = prev?.interp ?? DEFAULT_INTERP;
  keys.push({ id: newId(), t_us: tUs, value, interp });
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

export type { Keyframe };
