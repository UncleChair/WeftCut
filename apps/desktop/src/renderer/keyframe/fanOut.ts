// Twin-write helper for composite (fan-out) descriptors: one authored track
// becomes the batch entries for every target key, in a single
// `update_layer_param_tracks` call (one commit, one undo). Pairs with the
// main-side twin invariant (main/state/mutations/scaleLink.ts): the batch
// result is twins, so a linked layer STAYS linked.
import type { AnimTrack, Interpolation } from "../ipc";

function cloneInterp(i: Interpolation): Interpolation {
  return i.kind === "Bezier"
    ? { kind: "Bezier", p1: [i.p1[0], i.p1[1]], p2: [i.p2[0], i.p2[1]] }
    : { kind: i.kind };
}

/// Structural copy with fresh keyframe ids. Ids are per-track identities (the
/// twin comparison ignores them) and the linked UI never surfaces the copy's
/// key, so re-minting on every fan-out orphans no selection.
export function twinTrackCopy(track: AnimTrack<number>): AnimTrack<number> {
  if (track.mode === "Static") return { mode: "Static", value: track.value };
  return {
    mode: "Keyframed",
    value: track.value.map((k) => ({ id: crypto.randomUUID(), t_us: k.t_us, value: k.value, interp: cloneInterp(k.interp) })),
  };
}

/// Batch entries for a fan-out commit: the authored track under its own key,
/// a fresh-id twin under every other. `keys` is the descriptor's fanOutKeys.
export function fanOutEntries(keys: string[], next: AnimTrack<number>): [string, AnimTrack<number>][] {
  return keys.map((key, i) => [key, i === 0 ? next : twinTrackCopy(next)]);
}
