// Pure read-only queries over an AnimTrack<number> for the keyframe navigator.
// Distinct from the transforms in `edits.ts` (which return new tracks). Times
// are layer-local microseconds; the caller pre-snaps to the frame grid. Static
// tracks have no keys, so every query returns null for them.
import type { AnimTrack, Keyframe, LayerSummary, TrackSummary } from "../ipc";
import { isHiddenTwinAxis, readParamTrack } from "./descriptors";

/// The key whose t_us exactly equals tUs (caller pre-snaps), or null.
export function keyAt(track: AnimTrack<number>, tUs: number): Keyframe<number> | null {
  if (track.mode !== "Keyframed") return null;
  return track.value.find((k) => k.t_us === tUs) ?? null;
}

/// The latest key strictly before tUs (strict `<` so sitting on a key steps
/// off it), or null. Does not assume the keys are sorted.
export function prevKeyAt(track: AnimTrack<number>, tUs: number): Keyframe<number> | null {
  if (track.mode !== "Keyframed") return null;
  let best: Keyframe<number> | null = null;
  for (const k of track.value) {
    if (k.t_us < tUs && (best === null || k.t_us > best.t_us)) best = k;
  }
  return best;
}

/// The earliest key strictly after tUs, or null.
export function nextKeyAt(track: AnimTrack<number>, tUs: number): Keyframe<number> | null {
  if (track.mode !== "Keyframed") return null;
  let best: Keyframe<number> | null = null;
  for (const k of track.value) {
    if (k.t_us > tUs && (best === null || k.t_us < best.t_us)) best = k;
  }
  return best;
}

/// Which clip on the track the navigator for `paramKey` acts on:
///  1. the focused clip, if it is on the track AND has `paramKey` Keyframed;
///  2. else the sole clip with `paramKey` Keyframed;
///  3. else null (ambiguous — the navigator disables itself).
export function resolveNavLayer(
  track: TrackSummary,
  paramKey: string,
  focusedLayerId: string | null,
): LayerSummary | null {
  const candidates = track.layers.filter((l) => {
    if (isHiddenTwinAxis(paramKey, l.params)) return false;
    const t = readParamTrack(l.params, paramKey);
    return t?.mode === "Keyframed";
  });
  if (candidates.length === 0) return null;
  if (focusedLayerId) {
    const focused = candidates.find((l) => l.id === focusedLayerId);
    if (focused) return focused;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}
