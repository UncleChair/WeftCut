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

/// Find the cut nearest to `tUs` across ALL tracks, with no distance limit —
/// the target-resolution kernel behind every argumentless "apply transition"
/// surface (palette command, Quick Actions button, Transitions panel card).
/// The registry has no parameterized-command shape, so the target must come
/// from state; this is where.
///
/// Selection preference: when any selected layer participates in a cut, only
/// those cuts compete — the user's selection names the join they mean, even
/// with the playhead parked elsewhere. A selection touching no cut falls back
/// to the global search rather than refusing.
///
/// Ties are deterministic: nearer wins, then the lower track index, then the
/// earlier cut. Same eligibility as `findCutNear` (adjacent visual pairs,
/// audio never participates).
export function findNearestCut(
  tracks: readonly TrackSummary[],
  tUs: number,
  selectedLayerIds?: ReadonlySet<string>,
): TransitionCut | null {
  const pick = (restrictToSelection: boolean): TransitionCut | null => {
    let best: {
      cut: TransitionCut;
      dist: number;
      trackIndex: number;
    } | null = null;
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      const track = tracks[trackIndex]!;
      for (const from of track.layers) {
        if (!VISUAL_LAYER_KINDS.has(from.kind)) continue;
        const to = track.layers.find(
          (l) =>
            l.id !== from.id &&
            VISUAL_LAYER_KINDS.has(l.kind) &&
            l.t_start_us === from.t_end_us,
        );
        if (!to) continue;
        if (
          restrictToSelection &&
          !selectedLayerIds!.has(from.id) &&
          !selectedLayerIds!.has(to.id)
        )
          continue;
        const dist = Math.abs(tUs - from.t_end_us);
        const wins =
          best === null ||
          dist < best.dist ||
          (dist === best.dist &&
            (trackIndex < best.trackIndex ||
              (trackIndex === best.trackIndex &&
                from.t_end_us < best.cut.cutUs)));
        if (wins) {
          best = {
            cut: {
              fromLayerId: from.id,
              toLayerId: to.id,
              cutUs: from.t_end_us,
            },
            dist,
            trackIndex,
          };
        }
      }
    }
    return best?.cut ?? null;
  };
  if (selectedLayerIds !== undefined && selectedLayerIds.size > 0) {
    const preferred = pick(true);
    if (preferred !== null) return preferred;
  }
  return pick(false);
}

/// The chip menu's quick-duration ladder, in seconds. Arbitrary values stay
/// with edge drag and the inspector timecode field — these are the common
/// grabs, not a complete range.
export const TRANSITION_DURATION_PRESETS_SEC = [0.5, 1, 2] as const;

/// `seconds` snapped DOWN to a whole composition-frame count, minimum
/// 1 frame.
///
/// The µs value comes from `timeUsAtFrame`, not local arithmetic, so the UI
/// proposes a whole-frame duration that `applyAddTransition`'s own grid snap
/// accepts unchanged — which is also what makes the preset checkmark a plain
/// `===` against the stored `duration_us`.
export function presetTransitionDurationUs(
  seconds: number,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) return Math.round(seconds * US_PER_SEC);
  const wholeFrames = Math.max(1, Math.floor((seconds * fpsNum) / fpsDen));
  return timeUsAtFrame(wholeFrames, fpsNum, fpsDen);
}

/// Default duration: the 1 s preset. Hardcoded — no settings entry.
export function defaultTransitionDurationUs(
  fpsNum: number,
  fpsDen: number,
): number {
  return presetTransitionDurationUs(1, fpsNum, fpsDen);
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

/// `update_transition` wire args, as assembled by the chip menu's three
/// submenus. Pure so the menu semantics get unit tests — Base UI's
/// submenu-open is hover-intent machinery jsdom can't drive, so the component
/// test stops at "the submenu triggers render" and these carry the contract.
export interface TransitionUpdateArgs {
  transitionId: string;
  durationUs?: number;
  kind?: TransitionKindName;
  direction?: TransitionDirection;
}

/// Kind pick: Wipe↔Slide keeps the current direction; switching to Crossfade
/// drops it; switching out of Crossfade takes the 'left' default — all of
/// which is `buildTransitionKindArgs`'s contract. Null = picked the current
/// kind, nothing to commit.
export function transitionKindUpdateArgs(
  transition: TransitionSummary,
  next: TransitionKindName,
): TransitionUpdateArgs | null {
  if (next === transition.kind.kind) return null;
  return {
    transitionId: transition.id,
    ...buildTransitionKindArgs(next, transitionDirectionOf(transition.kind)),
  };
}

/// Direction pick: kind rides along (the wire contract pairs them). Null =
/// picked the current direction, or the kind is Crossfade (which the menu
/// prevents by hiding the submenu — this is the belt to that suspender).
export function transitionDirectionUpdateArgs(
  transition: TransitionSummary,
  direction: TransitionDirection,
): TransitionUpdateArgs | null {
  if (transition.kind.kind === "Crossfade") return null;
  if (direction === transitionDirectionOf(transition.kind)) return null;
  return { transitionId: transition.id, kind: transition.kind.kind, direction };
}

/// Duration pick. Null = the preset already matches (the checkmarked row).
export function transitionDurationUpdateArgs(
  transition: TransitionSummary,
  durationUs: number,
): TransitionUpdateArgs | null {
  if (durationUs === transition.duration_us) return null;
  return { transitionId: transition.id, durationUs };
}

// Structured backend errors are parsed by the app-wide
// `errors/parseCommandError.ts` and rendered by `errors/formatCommandError.ts`;
// transition call sites report failures through `logMutationFailure`.
