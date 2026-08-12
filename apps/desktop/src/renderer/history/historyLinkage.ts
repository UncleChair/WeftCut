import type { HistoryEntityRef } from "../ipc";
import {
  revealLayerWithoutSeek,
  revealTrackWithoutSelection,
} from "../state/navigation";
import { useProjectStore } from "../state/projectStore";

/// The post-jump linkage: select what the entry touched and reveal where it
/// lives — without moving the playhead (spec decision 8).
///
/// ORDERING HAZARD, and the reason this is its own module: `projectJumpTo`
/// resolves as soon as MAIN has moved the cursor, which is strictly before the
/// `project:changed` → `projectSummary()` round trip that refreshes
/// `layerById`. Resolving `affected` against that stale index selects the
/// wrong layer, or (much more often) nothing at all — the layer the entry
/// re-introduced isn't in the index yet. So the caller must arm
/// `afterNextProjectSummary()` BEFORE issuing the jump and await it before
/// calling `revealAffected`.

export interface PendingProjectSummary {
  /// Resolves when `projectStore` publishes a summary that isn't the one that
  /// was current when this was armed — or when `timeoutMs` elapses.
  settled: Promise<void>;
  /// Drop the subscription without waiting (the jump was refused).
  cancel: () => void;
}

/// Arm a one-shot wait for the next `projectStore` publication.
///
/// Armed BEFORE the jump on purpose: the refetch can land while
/// `projectJumpTo` is still awaiting, and a subscription registered after that
/// would wait for an event that has already gone by.
///
/// The timeout is a liveness backstop, not a policy: `jumpTo` always
/// broadcasts (ticket 02 — even a jump to the current index), so under normal
/// operation the subscription fires long first. Without it a dropped broadcast
/// would leave the caller awaiting forever.
export function afterNextProjectSummary(
  timeoutMs = 4_000,
): PendingProjectSummary {
  const baseline = useProjectStore.getState().summary;
  let finish: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    let done = false;
    const unsubscribe = useProjectStore.subscribe((state) => {
      if (done || state.summary === baseline) return;
      finish();
    });
    const timer = setTimeout(() => finish(), timeoutMs);
    finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
  });
  return { settled, cancel: () => finish() };
}

/// Resolve one entry's `affected` refs against the LIVE project index and
/// select + reveal the first thing that resolves. Returns true when something
/// was revealed.
///
/// Layers win over Tracks regardless of position: "select the first resolvable
/// affected layer" is the rule, and a Layer ref is the only one there is
/// anything to select for. A Track-only entry (`add_track` /
/// `add_caption_track`, whose ids are minted inside the recipe with no layer
/// to name) falls through to a reveal-without-selection. Marker refs resolve
/// to nothing — the renderer has no marker-selection model.
export function revealAffected(refs: readonly HistoryEntityRef[]): boolean {
  for (const ref of refs) {
    if (ref.kind === "Layer" && revealLayerWithoutSeek(ref.id)) return true;
  }
  for (const ref of refs) {
    if (ref.kind === "Track" && revealTrackWithoutSelection(ref.id)) return true;
  }
  return false;
}
