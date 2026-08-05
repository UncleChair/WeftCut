// Shared stand-down rule for the timeline's capture-phase Delete preemptors.
//
// Three listeners claim Delete/Backspace for a timeline SUB-selection before
// the app-level delete-selected-layer shortcut can see it: the keyframe diamond
// (`LayerBlock`), the keyframe lane (`KeyframeLane`), and the transition chip
// (`Timeline`). Winning that race is why they exist, and why they are raw
// capture-phase `window` listeners with `stopImmediatePropagation()` instead of
// entries in `ACTION_DEFS`.
//
// The cost of bypassing the dispatcher is that they must reproduce its
// stand-down rules by hand — and every rule any one of them forgets becomes
// "Delete does something different depending on which selection happens to be
// armed". Hence one predicate, three call sites.

import { isEditableTarget } from "../shortcuts/match";
import { activeRegion } from "../focus/focusRegionStore";

/// True when a sub-selection must NOT claim this Delete. Mirrors the two rules
/// `deleteSelected` carries in `ACTION_DEFS`:
///
///   * a bare key is dead while a text field is focused — otherwise Delete
///     aimed at a character in the Attribute panel silently removes a keyframe
///     and eats the keystroke;
///   * `scope: ["timeline"]` is dead unless the timeline region owns the
///     keyboard (ADR 0041).
export function subSelectionDeleteYields(target: EventTarget | null): boolean {
  return isEditableTarget(target) || activeRegion() !== "timeline";
}
