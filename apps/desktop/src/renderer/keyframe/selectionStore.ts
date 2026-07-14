// Single source of truth for keyframe SELECTION (collapsed + expanded
// diamonds share it). Transient — not persisted, not undo. Atomic selectors
// only (per feedback_zustand_composite_selector). v1 is single-selection; the
// inner value can widen to a Set in the multi-select fast-follow.
import { create } from "zustand";

export interface SelectedKeyframe {
  layerId: string;
  paramKey: string;
  kfId: string;
}

interface State {
  selected: SelectedKeyframe | null;
}

export const useKeyframeSelectionStore = create<State>(() => ({ selected: null }));

export function selectKeyframe(key: SelectedKeyframe): void {
  useKeyframeSelectionStore.setState({ selected: key });
}

export function clearKeyframeSelection(): void {
  useKeyframeSelectionStore.setState({ selected: null });
}

export function getSelectedKeyframe(): SelectedKeyframe | null {
  return useKeyframeSelectionStore.getState().selected;
}
