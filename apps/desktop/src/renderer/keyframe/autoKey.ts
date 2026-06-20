// The single source of the "commit a scalar to an animatable param" rule,
// shared by the inspector and the timeline value field. Pure: Keyframed →
// upsert a key at the playhead-local time; Static → a plain value write.
// Pairs with `displayValue` (the read side) in components/AnimatableField.tsx.
import type { AnimTrack } from "../ipc";
import { upsertKeyframe } from "./edits";

export function autoKeyTrack(
  track: AnimTrack<number>,
  tInLayerUs: number,
  val: number,
): AnimTrack<number> {
  return track.mode === "Keyframed"
    ? upsertKeyframe(track, tInLayerUs, val)
    : { mode: "Static", value: val };
}
