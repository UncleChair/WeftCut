// Pure timeline-side transition helpers: cut detection for the right-click
// create gesture, the hardcoded 1 s frame-snapped default duration, chip
// geometry, and (kind, direction) wire-arg pairing for add/update_transition.
// Pure functions only — the components stay thin and these get unit tests.
// See ADR 0035.

import type {
  LayerSummary,
  TrackSummary,
  TransitionDirection,
  TransitionKindView,
  TransitionSummary,
} from "../ipc";
import { timeUsAtFrame } from "../frames";
import { VISUAL_LAYER_KINDS } from "../render/transitions/activeTransitions";
import type { LayerSlice } from "./geometry";

const US_PER_SEC = 1_000_000;

/// Click-tolerance band around the zero-width seam, in px. Matches
/// LayerBlock's EDGE_ZONE_PX so the two edge affordances feel like one.
export const CUT_CLICK_TOLERANCE_PX = 6;

export type TransitionKindName = TransitionKindView["kind"];

export const TRANSITION_KIND_NAMES: readonly TransitionKindName[] = [
  "Crossfade",
  "Wipe",
  "Slide",
];

export const TRANSITION_DIRECTIONS: readonly TransitionDirection[] = [
  "left",
  "right",
  "up",
  "down",
];

/// A hard cut between two same-track adjacent VISUAL layers — the only place
/// `add_transition` (adjacent case) is valid. `cutUs` is the shared boundary:
/// `from.t_end_us === to.t_start_us`.
export interface TransitionCut {
  fromLayerId: string;
  toLayerId: string;
  cutUs: number;
}

/// Find the cut nearest to `tUs` within `toleranceUs`, or null. Only exact
/// adjacency counts (a pair already overlapped by a transition no longer
/// shares a boundary, so it naturally stops matching). Audio layers never
/// participate (ADR 0035 § Placement, participants, and handle).
export function findCutNear(
  layers: readonly LayerSummary[],
  tUs: number,
  toleranceUs: number,
): TransitionCut | null {
  let best: { cut: TransitionCut; dist: number } | null = null;
  for (const from of layers) {
    if (!VISUAL_LAYER_KINDS.has(from.kind)) continue;
    const dist = Math.abs(tUs - from.t_end_us);
    if (dist > toleranceUs) continue;
    if (best !== null && dist >= best.dist) continue;
    for (const to of layers) {
      if (to.id === from.id) continue;
      if (!VISUAL_LAYER_KINDS.has(to.kind)) continue;
      if (to.t_start_us !== from.t_end_us) continue;
      best = {
        cut: { fromLayerId: from.id, toLayerId: to.id, cutUs: from.t_end_us },
        dist,
      };
      break;
    }
  }
  return best?.cut ?? null;
}

/// Default duration: 1 second snapped DOWN to a whole composition-frame
/// count, minimum 1 frame. Hardcoded — no settings entry.
///
/// The µs value comes from `timeUsAtFrame`, not local arithmetic, so the UI
/// proposes a whole-frame duration that `applyAddTransition`'s own grid snap
/// accepts unchanged.
export function defaultTransitionDurationUs(
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) return US_PER_SEC;
  const wholeFrames = Math.max(1, Math.floor(fpsNum / fpsDen));
  return timeUsAtFrame(wholeFrames, fpsNum, fpsDen);
}

/// One chip on a track lane. Start-at-cut alignment: the window is the
/// incoming layer's first `duration_us` µs, i.e. it starts at the OLD cut
/// point and spans the authorized overlap.
export interface TrackTransitionChip {
  transition: TransitionSummary;
  toLayer: LayerSummary;
  /// Window start == `toLayer.t_start_us` (the cut).
  startUs: number;
  /// `startUs + duration_us`.
  endUs: number;
}

/// Chips whose BOTH participants live on `track`. Reconcile guarantees the
/// invariant at the commit seam; a mid-refresh mismatch simply drops the chip
/// for a frame instead of drawing it detached.
export function transitionChipsForTrack(
  track: TrackSummary,
  transitions: readonly TransitionSummary[] | undefined,
): TrackTransitionChip[] {
  if (!transitions || transitions.length === 0) return [];
  const out: TrackTransitionChip[] = [];
  for (const tr of transitions) {
    const toLayer = track.layers.find((l) => l.id === tr.to_layer);
    if (!toLayer) continue;
    if (!track.layers.some((l) => l.id === tr.from_layer)) continue;
    out.push({
      transition: tr,
      toLayer,
      startUs: toLayer.t_start_us,
      endUs: toLayer.t_start_us + tr.duration_us,
    });
  }
  return out;
}

/// Vertical slot for a chip inside a lane row — mirrors LayerBlock's slice
/// math (ROW_PADDING 4, 1px midline gap) so the chip hugs the incoming
/// layer's block exactly in both full-row and combined V+A rows.
export function chipSliceSlot(
  laneHeight: number,
  slice: LayerSlice,
): { top: number; height: number } {
  const ROW_PADDING = 4;
  const interiorTop = ROW_PADDING;
  const interiorHeight = Math.max(8, laneHeight - 2 * ROW_PADDING);
  const halfHeight = Math.max(8, Math.floor((interiorHeight - 1) / 2));
  if (slice === "top") return { top: interiorTop, height: halfHeight };
  if (slice === "bottom")
    return {
      top: interiorTop + halfHeight + 1,
      height: interiorHeight - halfHeight - 1,
    };
  return { top: interiorTop, height: interiorHeight };
}

/// Flat (kind, direction) wire args for add/update_transition. The backend
/// REJECTS Wipe/Slide without a direction and Crossfade WITH one
/// (`parseTransitionKind`), so the pairing is assembled here once: Crossfade
/// omits direction; Wipe/Slide always carry one, defaulting to 'left' when
/// the caller has none (e.g. kind change away from Crossfade).
export interface TransitionKindArgs {
  kind: TransitionKindName;
  direction?: TransitionDirection;
}

export function buildTransitionKindArgs(
  kind: TransitionKindName,
  direction?: TransitionDirection | null,
): TransitionKindArgs {
  if (kind === "Crossfade") return { kind };
  return { kind, direction: direction ?? "left" };
}

/// Current direction of a wire kind, or null for Crossfade.
export function transitionDirectionOf(
  kind: TransitionKindView,
): TransitionDirection | null {
  return kind.kind === "Crossfade" ? null : kind.direction;
}

/// Structured backend errors arrive as `Error(JSON.stringify(err))`, possibly
/// wrapped in Electron IPC prose ("Error invoking remote method …"). Extract
/// the error name + `available_us` by regex — tolerant of any prefix/suffix —
/// so the UI can branch on TransitionInsufficientHandle instead of parsing
/// prose. Returns null when no structured `"error"` field is present.
export interface ParsedTransitionError {
  name: string;
  availableUs?: number;
}

export function parseTransitionCommandError(
  raw: string,
): ParsedTransitionError | null {
  const name = /"error"\s*:\s*"([A-Za-z0-9_]+)"/.exec(raw);
  if (!name || name[1] === undefined) return null;
  const available = /"available_us"\s*:\s*(\d+)/.exec(raw);
  if (available?.[1] !== undefined) {
    return { name: name[1], availableUs: Number(available[1]) };
  }
  return { name: name[1] };
}
